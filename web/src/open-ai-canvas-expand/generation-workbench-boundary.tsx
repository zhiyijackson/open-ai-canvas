import { Component, type ErrorInfo, type ReactNode } from "react";

type BoundaryProps = { children: ReactNode; onError: () => void };

export class GenerationWorkbenchBoundary extends Component<BoundaryProps, { failed: boolean }> {
    state = { failed: false };

    static getDerivedStateFromError() {
        return { failed: true };
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        console.error("扩展工作台渲染失败，已回退到宿主工作台", error, info.componentStack);
        this.props.onError();
    }

    render() {
        return this.state.failed ? null : this.props.children;
    }
}
