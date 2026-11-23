import { App, Button, Input } from "antd";
import { Smartphone } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { VerificationFields } from "@/components/auth/verification-fields";
import { Callout } from "@/components/ui/product/callout";
import { type LocalUser } from "@/services/api/auth";
import { bindVerification, emptyVerification } from "@/services/api/verification";
import { useAuthSettingsStore } from "@/stores/use-auth-settings-store";
import { useUserStore } from "@/stores/use-user-store";

export function ProfilePhoneBinding({ user, hasPassword, onBound }: { user: LocalUser; hasPassword: boolean; onBound: (user: LocalUser) => void }) {
    const available = useAuthSettingsStore((state) => state.settings?.smsBindingAvailable);
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [password, setPassword] = useState("");
    const [draft, setDraft] = useState(emptyVerification);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const inFlight = useRef(false);

    useEffect(() => {
        void useAuthSettingsStore.getState().load({ maxAgeMs: 0 });
    }, []);

    const confirm = async () => {
        if (!draft.ticket || !/^\d{6}$/.test(draft.smsCode) || inFlight.current) return;
        inFlight.current = true;
        setSaving(true);
        setError("");
        try {
            const result = await bindVerification(draft);
            if (useUserStore.getState().user?.id !== result.user.id) return;
            setPassword("");
            setDraft(emptyVerification);
            onBound(result.user);
            message.success(t("account.settings.profile.phoneBound", { defaultValue: "手机号已验证" }));
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : t("errors.requestFailed"));
        } finally {
            setSaving(false);
            inFlight.current = false;
        }
    };

    if (!available && !user.phoneVerifiedAt) return null;
    const title = t("account.settings.profile.bindPhone", { defaultValue: "绑定手机号" });
    return (
        <section className="profile-card">
            <div className="profile-card-heading">
                <span className="profile-card-icon">
                    <Smartphone className="size-5" />
                </span>
                <div>
                    <h3>{title}</h3>
                    <p>
                        {user.phoneVerifiedAt
                            ? t("account.settings.profile.phoneVerified", { defaultValue: "已验证 {{phone}}", phone: user.phone })
                            : t("account.settings.profile.phoneBindingDescription", { defaultValue: "验证后可使用手机号接收登录验证码。" })}
                    </p>
                </div>
            </div>
            {available &&
                (hasPassword ? (
                    <form
                        className="grid gap-3"
                        onSubmit={(event) => {
                            event.preventDefault();
                            void confirm();
                        }}
                    >
                        <Input.Password
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                            autoComplete="current-password"
                            aria-label={t("account.settings.profile.currentPassword")}
                            placeholder={t("account.settings.profile.currentPassword")}
                            required
                            disabled={saving}
                        />
                        <VerificationFields purpose="bind" method="sms" password={password} value={draft} onChange={setDraft} disabled={saving} />
                        {error && (
                            <Callout tone="error" role="alert">
                                {error}
                            </Callout>
                        )}
                        <Button className="justify-self-start" type="primary" htmlType="submit" disabled={!draft.ticket || !/^\d{6}$/.test(draft.smsCode)} loading={saving}>
                            {title}
                        </Button>
                    </form>
                ) : (
                    <Callout tone="info">{t("account.settings.profile.phoneNeedsPassword", { defaultValue: "请先在上方设置密码，再绑定手机号。" })}</Callout>
                ))}
        </section>
    );
}
