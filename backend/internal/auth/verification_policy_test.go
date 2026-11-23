package auth

import (
	"encoding/json"
	"testing"

	"yingce/backend/internal/model"
	"yingce/backend/internal/sms"
)

func TestUpdateSMSLoginWithDefaultEmailPolicyAndNoSMTP(t *testing.T) {
	svc, db := newRegistrationTestService(t)
	admin := &model.User{ID: "admin", Role: model.UserRoleAdmin, Status: model.UserStatusActive}
	if err := svc.repo.DeleteSystemSetting(emailSettingKey); err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.SMSChannel{}); err != nil {
		t.Fatal(err)
	}
	templates, err := json.Marshal([]sms.Template{{Purpose: "login", TemplateID: "SMS_TEST"}})
	if err != nil {
		t.Fatal(err)
	}
	channel := &model.SMSChannel{ID: "sms-test", Provider: sms.Aliyun, Enabled: true, TemplatesJSON: string(templates)}
	if err := db.Create(channel).Error; err != nil {
		t.Fatal(err)
	}
	pluginEnabled := false
	svc.sms = sms.New(svc.repo, svc.host, func(string) (bool, error) { return pluginEnabled, nil })
	if enabled, err := svc.EmailEnabled(); err != nil || enabled {
		t.Fatalf("expected an environment without SMTP, got %v, %v", enabled, err)
	}
	if _, err := svc.UpdateVerificationPolicy(admin, VerificationPolicy{SMSLogin: true, EmailRegistration: true}); err == nil {
		t.Fatal("enabled SMS login without an available SMS channel")
	}
	pluginEnabled = true
	if _, err := svc.UpdateVerificationPolicy(admin, VerificationPolicy{SMSLogin: true, EmailLogin: true, EmailRegistration: true}); err == nil {
		t.Fatal("enabled email login without SMTP")
	}
	for _, enabled := range []bool{true, false} {
		want := VerificationPolicy{SMSLogin: enabled, EmailRegistration: true}
		if _, err := svc.UpdateVerificationPolicy(admin, want); err != nil {
			t.Fatal(err)
		}
		if got, err := svc.verificationPolicy(); err != nil || got != want {
			t.Fatalf("saved policy = %+v, %v, want %+v", got, err, want)
		}
		pluginEnabled = false
	}
}
