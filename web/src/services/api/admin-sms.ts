import { http } from "./request";

export type SmsPurpose = "login" | "bind" | "register";

export type SmsTemplate = {
    purpose: SmsPurpose;
    templateId: string;
    parameters: { name: string; value: "code" | "minutes" }[];
};

type SmsChannelSettings = {
    name: string;
    provider: string;
    enabled: boolean;
    priority: number;
    dailyLimit: number;
    signName: string;
    appId: string;
    templates: SmsTemplate[];
    version: number;
};

export type SmsChannel = SmsChannelSettings & {
    id: string;
    hasCredentials: boolean;
    pluginEnabled: boolean;
};

export type SmsChannelInput = SmsChannelSettings & { accessId?: string; accessKey?: string };

type SmsRecord = {
    id: string;
    maskedPhone: string;
    purpose: SmsPurpose | `test:${SmsPurpose}`;
    state: "accepted" | "rejected" | "unknown";
    errorCode: string;
    createdAt: string;
};

export const listSmsChannels = () => http.get<SmsChannel[]>("/admin/sms/channels");

export function saveSmsChannel(input: SmsChannelInput, id?: string) {
    return id ? http.put<SmsChannel>(`/admin/sms/channels/${encodeURIComponent(id)}`, input) : http.post<SmsChannel>("/admin/sms/channels", input);
}

export const testSmsChannel = (id: string, phone: string, purpose: SmsPurpose) => http.post<SmsRecord>(`/admin/sms/channels/${encodeURIComponent(id)}/test`, { phone, purpose });

export const listSmsRecords = (id: string) => http.get<{ items: SmsRecord[]; total: number }>("/admin/sms/records", { params: { channelId: id, page: 1, pageSize: 5 } });
