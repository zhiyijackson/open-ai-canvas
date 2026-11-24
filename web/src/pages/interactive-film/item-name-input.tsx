import { Input } from "antd";

type Props = { value?: string; placeholder: string; "aria-label"?: string; onChange: (value: string) => void };

export function ItemNameInput({ value = "", onChange, ...props }: Props) {
    return (
        <Input
            {...props}
            value={value}
            maxLength={60}
            onChange={(event) => onChange(event.target.value)}
            onBlur={(event) => {
                const name = event.target.value.trim();
                if (name !== event.target.value) onChange(name);
            }}
        />
    );
}
