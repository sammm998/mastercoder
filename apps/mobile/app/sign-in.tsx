import { useState } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet, View } from "react-native";
import { errorText, trpc, useSession } from "../src/api";
import { Body, Button, Caption, Card, Display, ErrorBanner, Field, Heading, Small } from "../src/components/ui";
import { useI18n } from "../src/i18n";
import { extractMagicToken, isValidEmail } from "../src/lib/auth";
import { colors, space } from "../src/theme";
import { Screen } from "../src/components/ui";

export default function SignIn() {
  const { t, locale } = useI18n();
  const session = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [magicEmail, setMagicEmail] = useState("");
  const [link, setLink] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const login = trpc.auth.login.useMutation({ onSuccess: (r) => session.signIn(r.token) });
  const magic = trpc.auth.requestMagicLink.useMutation();
  const verify = trpc.auth.verifyMagicLink.useMutation({ onSuccess: (r) => session.signIn(r.token) });

  const submitPassword = () => {
    setFormError(null);
    if (!isValidEmail(email)) return setFormError(t("signIn.invalidEmail"));
    login.mutate({ email: email.trim(), password });
  };
  const sendMagic = () => {
    setFormError(null);
    const e = magicEmail.trim() || email.trim();
    if (!isValidEmail(e)) return setFormError(t("signIn.invalidEmail"));
    magic.mutate({ email: e, locale });
  };
  const useLink = () => {
    setFormError(null);
    const token = extractMagicToken(link);
    if (!token) return setFormError(t("signIn.invalidLink"));
    verify.mutate({ token, locale });
  };

  const apiError = login.error ?? magic.error ?? verify.error;

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Screen edges={["top", "bottom"]}>
        <View style={styles.hero}>
          <Caption style={{ color: colors.accent }}>{t("app.name")}</Caption>
          <Display>{t("app.tagline")}</Display>
          <Body style={{ color: colors.muted }}>{t("signIn.lead")}</Body>
        </View>

        {formError ? <ErrorBanner message={formError} /> : null}
        {apiError ? <ErrorBanner message={verify.error ? t("signIn.linkFailed") : errorText(apiError, t)} /> : null}

        <Card>
          <Heading>{t("signIn.title")}</Heading>
          <Field
            label={t("signIn.email")}
            value={email}
            onChangeText={setEmail}
            placeholder={t("signIn.emailPlaceholder")}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            textContentType="username"
            returnKeyType="next"
          />
          <Field
            label={t("signIn.password")}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete="current-password"
            textContentType="password"
            returnKeyType="go"
            onSubmitEditing={submitPassword}
          />
          <Button label={login.isPending ? t("signIn.submitting") : t("signIn.submit")} onPress={submitPassword} busy={login.isPending} disabled={!email || !password} />
        </Card>

        <Small style={styles.or}>{t("signIn.or")}</Small>

        <Card>
          <Heading>{t("signIn.magicTitle")}</Heading>
          <Small>{t("signIn.magicLead")}</Small>
          <Field
            label={t("signIn.email")}
            value={magicEmail || email}
            onChangeText={setMagicEmail}
            placeholder={t("signIn.emailPlaceholder")}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
          />
          <Button label={magic.isPending ? t("signIn.magicSending") : t("signIn.magicSend")} onPress={sendMagic} variant="secondary" busy={magic.isPending} />
          {magic.isSuccess ? (
            <Body accessibilityLabel={t("signIn.magicSent", { email: magicEmail || email })} style={{ color: colors.success }}>
              {t("signIn.magicSent", { email: magicEmail || email })}
            </Body>
          ) : null}
          <Field
            label={t("signIn.pasteLabel")}
            value={link}
            onChangeText={setLink}
            placeholder={t("signIn.pastePlaceholder")}
            autoCapitalize="none"
            autoCorrect={false}
            onSubmitEditing={useLink}
          />
          <Button label={verify.isPending ? t("signIn.verifying") : t("signIn.pasteSubmit")} onPress={useLink} variant="secondary" busy={verify.isPending} disabled={!link} />
        </Card>
      </Screen>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  hero: { gap: space.md, paddingTop: space.xxl, paddingBottom: space.md },
  or: { textAlign: "center" },
});
