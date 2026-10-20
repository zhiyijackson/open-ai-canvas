import { afterAll, expect, test } from "bun:test";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost/" });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    HTMLElement: dom.HTMLElement,
    Element: dom.Element,
    Node: dom.Node,
    SVGElement: dom.SVGElement,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
})) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

const { act, Component } = await import("react");
const { createRoot } = await import("react-dom/client");
const { GenerationWorkbenchBoundary } = await import("../../src/open-ai-canvas-expand/generation-workbench-boundary");

afterAll(() => {
    dom.happyDOM.abort();
    for (const [key, value] of originals) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
    }
});

test("surface failure switches the existing controller to fallback without a second mounted controller", async () => {
    let mounts = 0;
    let unmounts = 0;

    class ExplodingSurface extends Component<Record<string, never>, { failed: boolean }> {
        state = { failed: false };

        componentDidMount() {
            this.setState({ failed: true });
        }

        render() {
            if (this.state.failed) throw new Error("surface failed");
            return <span>扩展视图</span>;
        }
    }

    class Controller extends Component<Record<string, never>, { surfaceFailed: boolean }> {
        state = { surfaceFailed: false };

        componentDidMount() {
            mounts += 1;
        }

        componentWillUnmount() {
            unmounts += 1;
        }

        render() {
            if (this.state.surfaceFailed) return <span>宿主回退</span>;
            return (
                <GenerationWorkbenchBoundary onError={() => this.setState({ surfaceFailed: true })}>
                    <ExplodingSurface />
                </GenerationWorkbenchBoundary>
            );
        }
    }

    const host = document.createElement("div");
    const root = createRoot(host);
    const originalError = console.error;
    console.error = () => undefined;
    try {
        await act(async () => {
            root.render(<Controller />);
        });
        expect(host.textContent).toBe("宿主回退");
        expect(mounts).toBe(1);
        expect(unmounts).toBe(0);
    } finally {
        console.error = originalError;
        await act(async () => root.unmount());
    }
    expect(unmounts).toBe(1);
});
