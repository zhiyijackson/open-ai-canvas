import { Alert, App, Button, Checkbox, Form, Input, InputNumber, Select, Space, Spin } from "antd";
import { MessageSquareText } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";

import { listSmsChannels, listSmsRecords, saveSmsChannel, testSmsChannel, type SmsChannel, type SmsChannelInput, type SmsPurpose, type SmsTemplate } from "@/services/api/admin-sms";
import { fetchAdminPlugins } from "@/services/api/plugins";
import { getVerificationPolicy, saveVerificationPolicy } from "@/services/api/verification";
import { useAuthSettingsStore } from "@/stores/use-auth-settings-store";
import { useUserStore } from "@/stores/use-user-store";
import { SettingsSectionCard } from "./admin-ui";

const pluginId = "official-sms-aliyun";
const purposeLabels = { login: "登录", bind: "绑定手机号", register: "注册" };
const recordPurposeLabels = { ...purposeLabels, "test:login": "测试 · 登录", "test:bind": "测试 · 绑定手机号", "test:register": "测试 · 注册" };
const sendStates = { accepted: "已受理", rejected: "发送失败", unknown: "结果未知" };
const phonePattern = /^(?:\+86)?1[3-9]\d{9}$/;

type ChannelForm = Omit<SmsChannelInput, "provider" | "appId" | "version" | "templates"> & {
    login: Omit<SmsTemplate, "purpose">;
    bind: Omit<SmsTemplate, "purpose">;
};

function errorText(error: unknown) {
    return error instanceof Error ? error.message : "请求失败，请重试";
}

function TemplateFields({ purpose }: { purpose: "login" | "bind" }) {
    const form = Form.useFormInstance<ChannelForm>();
    const templateId = Form.useWatch([purpose, "templateId"], form);
    return (
        <fieldset className="min-w-0 rounded-lg border border-border px-3">
            <legend className="w-auto px-1 text-sm font-medium">{purposeLabels[purpose]}模板</legend>
            <Form.Item name={[purpose, "templateId"]} label="模板 Code" extra={purpose === "bind" ? "已有账号需要先绑定手机号时填写。" : undefined}>
                <Input placeholder="SMS_…" />
            </Form.Item>
            {templateId?.trim() ? (
                <Form.List name={[purpose, "parameters"]}>
                    {(fields, { add, remove }) => (
                        <div className="mb-3">
                            <p className="text-sm text-foreground/65">填写阿里云模板中的变量名，例如 code。</p>
                            {fields.map((field) => (
                                <div key={field.key} className="flex flex-wrap items-start gap-2">
                                    <Form.Item name={[field.name, "name"]} rules={[{ required: true, pattern: /^[a-zA-Z0-9_]{1,40}$/, message: "请输入有效变量名" }]}>
                                        <Input aria-label="模板变量名" placeholder="变量名" />
                                    </Form.Item>
                                    <Form.Item name={[field.name, "value"]} rules={[{ required: true }]}>
                                        <Select
                                            aria-label="变量来源"
                                            className="min-w-32"
                                            options={[
                                                { value: "code", label: "六位验证码" },
                                                { value: "minutes", label: "有效分钟数" },
                                            ]}
                                        />
                                    </Form.Item>
                                    <Button type="text" onClick={() => remove(field.name)}>
                                        移除
                                    </Button>
                                </div>
                            ))}
                            <Button size="small" disabled={fields.length >= 8} onClick={() => add({ name: "", value: "code" })}>
                                添加变量
                            </Button>
                        </div>
                    )}
                </Form.List>
            ) : null}
        </fieldset>
    );
}

function SmsChannelForm({ channel, pluginEnabled, onSaved }: { channel?: SmsChannel; pluginEnabled: boolean; onSaved: (channel: SmsChannel) => void }) {
    const [form] = Form.useForm<ChannelForm>();
    const { message } = App.useApp();
    const defaultTemplate = { templateId: "", parameters: [{ name: "code", value: "code" as const }] };
    const initialValues: ChannelForm = {
        name: channel?.name ?? "阿里云短信",
        enabled: channel?.enabled ?? pluginEnabled,
        priority: channel?.priority ?? 0,
        dailyLimit: channel?.dailyLimit ?? 100,
        signName: channel?.signName ?? "",
        login: channel?.templates.find((template) => template.purpose === "login") ?? defaultTemplate,
        bind: channel?.templates.find((template) => template.purpose === "bind") ?? defaultTemplate,
    };
    const save = useMutation({
        mutationFn: (values: ChannelForm) => {
            const { login, bind, ...settings } = values;
            const templates = channel?.templates.filter((template) => template.purpose === "register") ?? [];
            for (const purpose of ["login", "bind"] as const) {
                const template = purpose === "login" ? login : bind;
                const templateId = template.templateId?.trim();
                if (templateId) templates.push({ purpose, templateId, parameters: template.parameters ?? [] });
            }
            if (!templates.length) throw new Error("请至少填写一个场景的模板 Code");
            return saveSmsChannel({ ...settings, templates, provider: "aliyun", appId: channel?.appId ?? "", version: channel?.version ?? 0 }, channel?.id);
        },
        onSuccess: (saved) => {
            form.resetFields(["accessId", "accessKey"]);
            message.success("短信渠道已保存");
            onSaved(saved);
        },
    });
    return (
        <Form<ChannelForm> form={form} layout="vertical" initialValues={initialValues} onFinish={(values) => save.mutate(values)} disabled={save.isPending} autoComplete="off">
            <div className="grid gap-x-4 sm:grid-cols-2">
                <Form.Item name="name" label="渠道名称" rules={[{ required: true, whitespace: true }]}>
                    <Input />
                </Form.Item>
                <Form.Item name="signName" label="短信签名" rules={[{ required: true, whitespace: true }]}>
                    <Input />
                </Form.Item>
                <Form.Item name="accessId" label="AccessKey ID" rules={[{ required: !channel?.hasCredentials }]}>
                    <Input placeholder={channel?.hasCredentials ? "留空保留当前凭据" : undefined} />
                </Form.Item>
                <Form.Item name="accessKey" label="AccessKey Secret" rules={[{ required: !channel?.hasCredentials }]}>
                    <Input.Password autoComplete="new-password" placeholder={channel?.hasCredentials ? "留空保留当前凭据" : undefined} />
                </Form.Item>
                <Form.Item name="priority" label="优先级" rules={[{ required: true }]}>
                    <InputNumber min={0} max={1000} precision={0} className="w-full" />
                </Form.Item>
                <Form.Item name="dailyLimit" label="每日发送上限" rules={[{ required: true }]}>
                    <InputNumber min={1} max={100000} precision={0} className="w-full" />
                </Form.Item>
            </div>
            <div className="mb-4 grid gap-3 lg:grid-cols-2">
                <TemplateFields purpose="login" />
                <TemplateFields purpose="bind" />
            </div>
            <Form.Item name="enabled" valuePropName="checked">
                <Checkbox disabled={!pluginEnabled && !channel?.enabled}>启用渠道</Checkbox>
            </Form.Item>
            {save.error && <Alert className="mb-3" type="error" showIcon title={errorText(save.error)} />}
            <Button type="primary" htmlType="submit" loading={save.isPending}>
                保存渠道
            </Button>
        </Form>
    );
}

function SmsChannelDelivery({ channel }: { channel: SmsChannel }) {
    const [form] = Form.useForm<{ phone: string; purpose: SmsPurpose }>();
    const { message } = App.useApp();
    const userId = useUserStore((state) => state.user?.id);
    const records = useQuery({ queryKey: ["admin-sms-records", userId, channel.id], queryFn: () => listSmsRecords(channel.id), retry: false });
    const test = useMutation({
        mutationFn: ({ phone, purpose }: { phone: string; purpose: SmsPurpose }) => testSmsChannel(channel.id, phone.trim(), purpose),
        onSuccess: () => message.success("阿里云已受理，请检查测试手机是否收到短信"),
        onSettled: () => void records.refetch(),
    });
    return (
        <div className="grid gap-3 border-t border-border pt-4">
            <h3 className="text-sm font-medium">测试发送</h3>
            <Form
                form={form}
                layout="vertical"
                initialValues={{ purpose: channel.templates.find((template) => template.purpose === "login")?.purpose ?? channel.templates[0]?.purpose }}
                onFinish={(values) => test.mutate(values)}
                disabled={test.isPending || !channel.enabled || !channel.pluginEnabled}
            >
                <div className="grid items-start gap-x-3 sm:grid-cols-[1fr_10rem_auto]">
                    <Form.Item name="phone" label="测试手机号" rules={[{ required: true, pattern: phonePattern, message: "请输入中国大陆手机号" }]}>
                        <Input type="tel" autoComplete="off" />
                    </Form.Item>
                    <Form.Item name="purpose" label="场景" rules={[{ required: true }]}>
                        <Select options={channel.templates.map(({ purpose }) => ({ value: purpose, label: purposeLabels[purpose] }))} />
                    </Form.Item>
                    <Button className="sm:mt-[30px]" htmlType="submit" loading={test.isPending}>
                        发送测试短信
                    </Button>
                </div>
            </Form>
            {test.error && <Alert type="error" showIcon title={errorText(test.error)} />}
            <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium">最近发送记录</h3>
                <Button size="small" onClick={() => void records.refetch()} loading={records.isFetching}>
                    刷新记录
                </Button>
            </div>
            {records.error && <Alert type="error" showIcon title={errorText(records.error)} />}
            {records.data?.items.length === 0 && <span className="text-sm text-foreground/65">暂无发送记录</span>}
            {records.data?.items.map((record) => (
                <div key={record.id} className="flex flex-wrap gap-x-3 gap-y-1 border-b border-border pb-2 text-sm">
                    <span>{record.maskedPhone}</span>
                    <span>{recordPurposeLabels[record.purpose]}</span>
                    <span>{sendStates[record.state]}</span>
                    {record.errorCode && <span>{record.errorCode}</span>}
                    <time dateTime={record.createdAt} className="text-foreground/65">
                        {new Date(record.createdAt).toLocaleString()}
                    </time>
                </div>
            ))}
        </div>
    );
}

export default function SmsSettingsPanel() {
    const userId = useUserStore((state) => state.user?.id);
    const queryClient = useQueryClient();
    const { message } = App.useApp();
    const [selectedId, setSelectedId] = useState<string>();
    const [formRevision, setFormRevision] = useState(0);
    const queryKey = ["admin-sms-settings", userId];
    const settings = useQuery({
        queryKey,
        enabled: Boolean(userId),
        queryFn: async () => {
            const [channels, policy, plugins] = await Promise.all([listSmsChannels(), getVerificationPolicy(), fetchAdminPlugins()]);
            return { channels, policy, pluginEnabled: Boolean(plugins.states[pluginId]?.effectiveEnabled) };
        },
        retry: false,
        refetchOnWindowFocus: false,
    });
    const toggle = useMutation({
        mutationFn: async (smsLogin: boolean) => {
            const policy = await getVerificationPolicy();
            return policy.smsLogin === smsLogin ? policy : saveVerificationPolicy({ ...policy, smsLogin });
        },
        onSuccess: (policy) => {
            message.success(policy.smsLogin ? "短信验证码登录已开启" : "短信验证码登录已关闭");
            void settings.refetch();
            void useAuthSettingsStore.getState().load({ maxAgeMs: -1 });
        },
    });
    const aliyunChannels = settings.data?.channels.filter((channel) => channel.provider === "aliyun") ?? [];
    const channel = selectedId === undefined ? aliyunChannels[0] : aliyunChannels.find((item) => item.id === selectedId);
    const canLogin = settings.data?.channels.some((item) => item.enabled && item.pluginEnabled && item.templates.some((template) => template.purpose === "login"));
    const onSaved = (saved: SmsChannel) => {
        queryClient.setQueryData<typeof settings.data>(queryKey, (current) => current && { ...current, channels: [...current.channels.filter((item) => item.id !== saved.id), saved] });
        setSelectedId(saved.id);
        void settings.refetch();
        void useAuthSettingsStore.getState().load({ maxAgeMs: -1 });
    };
    return (
        <div className="admin-settings-stack">
            <SettingsSectionCard icon={<MessageSquareText className="size-4" />} title="短信验证码登录" description="配置阿里云文本短信渠道，向已验证手机号的账号发送登录验证码。" layout="stacked">
                {settings.isPending && <Spin />}
                {settings.error && <Alert type="error" showIcon title={errorText(settings.error)} />}
                {settings.data && (
                    <div className="grid gap-4">
                        {!settings.data.pluginEnabled && <Alert type="info" showIcon title="阿里云短信插件未启用" action={<Link to="/admin/plugins">打开插件管理</Link>} />}
                        <div className="flex flex-wrap items-center gap-3">
                            <Button aria-pressed={settings.data.policy.smsLogin} disabled={toggle.isPending || settings.isFetching || (!settings.data.policy.smsLogin && !canLogin)} onClick={() => toggle.mutate(!settings.data.policy.smsLogin)}>
                                {settings.data.policy.smsLogin ? "关闭短信验证码登录" : "开启短信验证码登录"}
                            </Button>
                            {!canLogin && <span className="text-sm text-foreground/65">开启前需启用含登录模板的短信渠道。</span>}
                        </div>
                        {toggle.error && <Alert type="error" showIcon title={errorText(toggle.error)} />}
                        <Space wrap>
                            <Select
                                aria-label="阿里云短信渠道"
                                className="min-w-52"
                                value={channel?.id ?? ""}
                                onChange={setSelectedId}
                                options={[{ value: "", label: "新建阿里云渠道" }, ...aliyunChannels.map((item) => ({ value: item.id, label: item.name }))]}
                            />
                            <Button
                                onClick={() => {
                                    setFormRevision((revision) => revision + 1);
                                    void settings.refetch();
                                }}
                                loading={settings.isFetching}
                            >
                                重新读取配置
                            </Button>
                        </Space>
                        <SmsChannelForm key={`${channel?.id}:${channel?.version}:${formRevision}`} channel={channel} pluginEnabled={settings.data.pluginEnabled} onSaved={onSaved} />
                        {channel && <SmsChannelDelivery key={`${channel.id}:${channel.version}`} channel={channel} />}
                    </div>
                )}
                {!settings.data && settings.error && (
                    <Button className="mt-3" onClick={() => void settings.refetch()}>
                        重试
                    </Button>
                )}
            </SettingsSectionCard>
        </div>
    );
}
