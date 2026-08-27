import React from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { CheckCircle2, Clock3, Loader2, Share2 } from "lucide-react";
import { SiInstagram, SiMessenger, SiWhatsapp } from "react-icons/si";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useChannelConnections,
  useConnectMeta,
  useConnectWhatsApp,
  useCompleteWhatsAppEmbeddedSignup,
  useMetaOAuthPages,
  useMetaOAuthUrl,
  useWhatsAppEmbeddedSignupConfig,
} from "@/queries/useChannelQueries";
import { useIsEntitled } from "@/queries/useEntitlementsQueries";
import type { StepProps } from "./types";
import { openMetaOAuthPopup } from "@/lib/metaOAuthPopup";
import { launchWhatsAppEmbeddedSignup } from "@/lib/whatsappEmbeddedSignup";

interface MetaPage {
  id: string;
  name: string;
  instagramAccount?: { username: string };
}

const CHANNEL_LABELS: Record<string, string> = {
  messenger: "Messenger",
  instagram: "Instagram",
  whatsapp: "WhatsApp",
};

function MetaPagesPicker({
  pages,
  isLoading,
  selectedPageIds,
  setSelectedPageIds,
  onConnect,
  isConnecting,
}: {
  pages: MetaPage[];
  isLoading: boolean;
  selectedPageIds: string[];
  setSelectedPageIds: React.Dispatch<React.SetStateAction<string[]>>;
  onConnect: () => void;
  isConnecting: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3 rounded-xl border border-primary-500/40 bg-surface-2 p-4">
      <div>
        <h3 className="text-sm font-semibold text-text-primary">
          {t("setup.steps.social.metaPagesTitle")}
        </h3>
        <p className="text-xs text-text-muted">
          {t("setup.steps.social.metaPagesDescription")}
        </p>
      </div>
      {isLoading ? (
        <Loader2 className="h-4 w-4 animate-spin text-text-muted" />
      ) : (
        <>
          {pages.map((page) => (
            <label
              key={page.id}
              className="flex cursor-pointer items-center gap-3 rounded-lg border border-edge px-3 py-2"
            >
              <Checkbox
                checked={selectedPageIds.includes(page.id)}
                onCheckedChange={(checked) =>
                  setSelectedPageIds((current) =>
                    checked
                      ? [...current, page.id]
                      : current.filter((pageId) => pageId !== page.id),
                  )
                }
              />
              <span className="text-sm text-text-primary">{page.name}</span>
              {page.instagramAccount && (
                <span className="flex items-center gap-1 text-xs text-text-muted">
                  <SiInstagram className="h-3.5 w-3.5" />@
                  {page.instagramAccount.username}
                </span>
              )}
            </label>
          ))}
          <Button
            onClick={onConnect}
            disabled={selectedPageIds.length === 0 || isConnecting}
          >
            {isConnecting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t("setup.steps.social.connectSelected")}
          </Button>
        </>
      )}
    </div>
  );
}

function ChannelCards({
  messengerActive,
  instagramActive,
  canConnectMeta,
  onConnectMeta,
  busy,
  oauthPending,
}: {
  messengerActive: boolean;
  instagramActive: boolean;
  canConnectMeta: boolean;
  onConnectMeta: () => void;
  busy: boolean;
  oauthPending: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-3 rounded-xl border border-edge bg-surface-2 p-4">
        <div className="flex items-center gap-2">
          <SiMessenger className="h-5 w-5 text-blue-400" />
          <h3 className="font-medium text-text-primary">Facebook Messenger</h3>
          {messengerActive && (
            <CheckCircle2 className="ml-auto h-4 w-4 text-status-online" />
          )}
        </div>
        <p className="text-xs text-text-muted">
          {t("setup.steps.social.messengerBody")}
        </p>
        {canConnectMeta ? (
          <Button variant="outline" onClick={onConnectMeta} disabled={busy}>
            {oauthPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t("setup.steps.social.connectMessenger")}
          </Button>
        ) : (
          <p className="text-xs text-text-muted">
            {t("setup.steps.social.upgradeHint")}
          </p>
        )}
      </div>

      <div className="space-y-3 rounded-xl border border-edge bg-surface-2 p-4">
        <div className="flex items-center gap-2">
          <SiInstagram className="h-5 w-5 text-pink-400" />
          <h3 className="font-medium text-text-primary">Instagram</h3>
          {instagramActive && (
            <CheckCircle2 className="ml-auto h-4 w-4 text-status-online" />
          )}
        </div>
        <p className="text-xs text-text-muted">
          {t("setup.steps.social.instagramBody")}
        </p>
      </div>
    </div>
  );
}

function WhatsAppConnect({
  canConnect,
  embeddedEnabled,
  busy,
  embeddedPending,
  manualPending,
  onConnectEmbedded,
  onConnectManual,
  phoneNumberId,
  setPhoneNumberId,
  accessToken,
  setAccessToken,
  wabaId,
  setWabaId,
}: {
  canConnect: boolean;
  embeddedEnabled: boolean;
  busy: boolean;
  embeddedPending: boolean;
  manualPending: boolean;
  onConnectEmbedded: () => void;
  onConnectManual: () => void;
  phoneNumberId: string;
  setPhoneNumberId: (value: string) => void;
  accessToken: string;
  setAccessToken: (value: string) => void;
  wabaId: string;
  setWabaId: (value: string) => void;
}) {
  const { t } = useTranslation();
  if (!canConnect) {
    return (
      <p className="text-xs text-text-muted">
        {t("setup.steps.social.upgradeHint")}
      </p>
    );
  }
  if (embeddedEnabled) {
    return (
      <Button variant="outline" onClick={onConnectEmbedded} disabled={busy}>
        {embeddedPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {t("setup.steps.social.connectWhatsApp")}
      </Button>
    );
  }
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="setup-wa-phone">
            {t("setup.steps.social.phoneNumberId")}
          </Label>
          <Input
            id="setup-wa-phone"
            value={phoneNumberId}
            onChange={(event) => setPhoneNumberId(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="setup-wa-token">
            {t("setup.steps.social.accessToken")}
          </Label>
          <Input
            id="setup-wa-token"
            type="password"
            value={accessToken}
            onChange={(event) => setAccessToken(event.target.value)}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="setup-wa-waba">
            {t("setup.steps.social.wabaId")}
          </Label>
          <Input
            id="setup-wa-waba"
            value={wabaId}
            onChange={(event) => setWabaId(event.target.value)}
          />
        </div>
      </div>
      <Button
        variant="outline"
        onClick={onConnectManual}
        disabled={busy || !phoneNumberId.trim() || !accessToken.trim()}
      >
        {manualPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {t("setup.steps.social.connectWhatsApp")}
      </Button>
    </>
  );
}

export function SocialStep({ submit }: StepProps) {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: connections, isLoading: connectionsLoading } =
    useChannelConnections();
  const metaOAuthUrl = useMetaOAuthUrl();
  const connectMeta = useConnectMeta();
  const connectWhatsApp = useConnectWhatsApp();
  const { data: waEsConfig } = useWhatsAppEmbeddedSignupConfig();
  const completeWhatsAppEs = useCompleteWhatsAppEmbeddedSignup();
  const whatsappEsEnabled = Boolean(
    waEsConfig?.enabled && waEsConfig.appId && waEsConfig.configId,
  );
  // Same plan gate as the Channels settings page: connect must not 402 on
  // Free. Essential+ has channelMessenger/channelWhatsapp; the plan step runs
  // before social, so these are live by the time the user reaches this step.
  const canConnectMeta = useIsEntitled("channelMessenger");
  const canConnectWhatsApp = useIsEntitled("channelWhatsapp");

  const metaSetupToken = searchParams.get("meta_setup");
  const { data: metaPagesData, isLoading: metaPagesLoading } =
    useMetaOAuthPages(metaSetupToken);
  const metaPages = (metaPagesData ?? []) as MetaPage[];
  const [selectedPageIds, setSelectedPageIds] = React.useState<string[]>([]);
  const [phoneNumberId, setPhoneNumberId] = React.useState("");
  const [accessToken, setAccessToken] = React.useState("");
  const [wabaId, setWabaId] = React.useState("");

  React.useEffect(() => {
    const pageIds = ((metaPagesData ?? []) as MetaPage[]).map(
      (page) => page.id,
    );
    setSelectedPageIds((current) =>
      current.length === pageIds.length &&
      current.every((id, index) => id === pageIds[index])
        ? current
        : pageIds,
    );
  }, [metaPagesData]);

  const activeChannels = new Set(
    connections
      ?.filter((connection) => connection.status === "active")
      .map((connection) => connection.channel),
  );
  const hasConnection =
    activeChannels.has("messenger") ||
    activeChannels.has("instagram") ||
    activeChannels.has("whatsapp");
  const busy =
    submit.isPending ||
    metaOAuthUrl.isPending ||
    connectMeta.isPending ||
    connectWhatsApp.isPending ||
    completeWhatsAppEs.isPending;

  const startMetaOAuth = async () => {
    const url = await metaOAuthUrl.mutateAsync({
      display: "popup",
      returnPath: "/setup",
    });
    if (!url) return;
    const result = await openMetaOAuthPopup(url);
    if (result.status === "navigated") return;
    if (result.status === "ok") {
      setSearchParams({ meta_setup: result.sessionToken });
      return;
    }
    if (result.status === "cancelled") {
      toast.info(
        t("setup.steps.social.facebookDenied", {
          defaultValue: "Facebook connect was cancelled.",
        }),
      );
      return;
    }
    toast.warning(
      t("setup.steps.social.facebookFailed", {
        defaultValue: "Facebook connect failed. Try again.",
      }),
    );
  };

  const connectSelectedPages = async () => {
    if (!metaSetupToken || selectedPageIds.length === 0) return;
    const result = await connectMeta.mutateAsync({
      pageIds: selectedPageIds,
      sessionToken: metaSetupToken,
    });

    if (result.skipped?.length) {
      toast.info(
        t("setup.steps.social.metaSkipped", {
          channels: result.skipped
            .map((channel) => CHANNEL_LABELS[channel] ?? channel)
            .join(", "),
        }),
      );
    }
    for (const warning of result.instagramWarnings ?? []) {
      toast.warning(
        t("setup.steps.social.instagramWarning", {
          page: warning.pageName || warning.pageId,
          reason: warning.reason,
        }),
      );
    }
    setSearchParams({});
  };

  const connectWhatsAppNumber = async () => {
    if (!phoneNumberId.trim() || !accessToken.trim()) return;
    await connectWhatsApp.mutateAsync({
      phoneNumberId: phoneNumberId.trim(),
      accessToken: accessToken.trim(),
      wabaId: wabaId.trim() || undefined,
    });
    setPhoneNumberId("");
    setAccessToken("");
    setWabaId("");
  };

  const connectWhatsAppEmbedded = async () => {
    if (!waEsConfig?.appId || !waEsConfig.configId) return;
    try {
      const result = await launchWhatsAppEmbeddedSignup({
        appId: waEsConfig.appId,
        configId: waEsConfig.configId,
        graphVersion: waEsConfig.graphVersion,
      });
      if (!result.session.phone_number_id || !result.session.waba_id) {
        toast.warning(
          t("setup.steps.social.whatsappEsMissing", {
            defaultValue:
              "WhatsApp signup finished without a phone number. Try again.",
          }),
        );
        return;
      }
      await completeWhatsAppEs.mutateAsync({
        code: result.code,
        phoneNumberId: result.session.phone_number_id,
        wabaId: result.session.waba_id,
      });
    } catch (err) {
      toast.warning(
        err instanceof Error
          ? err.message
          : t("setup.steps.social.whatsappEsFailed", {
              defaultValue: "WhatsApp connect failed. Try again.",
            }),
      );
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-4">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-surface-2">
          <Share2 className="h-5 w-5 text-primary-400" />
        </div>
        <div className="space-y-1.5">
          <h2 className="text-xl font-semibold text-text-primary">
            {t("setup.steps.social.title")}
          </h2>
          <p className="text-sm text-text-secondary">
            {t("setup.steps.social.body")}
          </p>
        </div>
      </div>

      {metaSetupToken && (
        <MetaPagesPicker
          pages={metaPages}
          isLoading={metaPagesLoading}
          selectedPageIds={selectedPageIds}
          setSelectedPageIds={setSelectedPageIds}
          onConnect={connectSelectedPages}
          isConnecting={connectMeta.isPending}
        />
      )}

      <ChannelCards
        messengerActive={activeChannels.has("messenger")}
        instagramActive={activeChannels.has("instagram")}
        canConnectMeta={canConnectMeta}
        onConnectMeta={startMetaOAuth}
        busy={busy}
        oauthPending={metaOAuthUrl.isPending}
      />

      <div className="space-y-4 rounded-xl border border-edge bg-surface-2 p-4">
        <div className="flex items-center gap-2">
          <SiWhatsapp className="h-5 w-5 text-emerald-400" />
          <h3 className="font-medium text-text-primary">WhatsApp</h3>
          {activeChannels.has("whatsapp") && (
            <CheckCircle2 className="ml-auto h-4 w-4 text-status-online" />
          )}
        </div>
        <p className="text-xs text-text-muted">
          {t("setup.steps.social.whatsappBody")}
        </p>
        <WhatsAppConnect
          canConnect={canConnectWhatsApp}
          embeddedEnabled={whatsappEsEnabled}
          busy={busy}
          embeddedPending={completeWhatsAppEs.isPending}
          manualPending={connectWhatsApp.isPending}
          onConnectEmbedded={connectWhatsAppEmbedded}
          onConnectManual={connectWhatsAppNumber}
          phoneNumberId={phoneNumberId}
          setPhoneNumberId={setPhoneNumberId}
          accessToken={accessToken}
          setAccessToken={setAccessToken}
          wabaId={wabaId}
          setWabaId={setWabaId}
        />
      </div>

      <div className="flex flex-wrap gap-2 text-xs text-text-muted">
        {["LinkedIn", "TikTok", "X"].map((channel) => (
          <span
            key={channel}
            className="flex items-center gap-1 rounded-full border border-edge px-2.5 py-1"
          >
            <Clock3 className="h-3 w-3" />
            {channel} · {t("setup.steps.social.comingSoon")}
          </span>
        ))}
      </div>

      <div className="flex justify-end">
        <Button
          size="lg"
          onClick={() => submit.mutate({ step: "social" })}
          disabled={busy || connectionsLoading}
        >
          {submit.isPending && (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          )}
          {t(hasConnection ? "setup.continue" : "setup.steps.social.later")}
        </Button>
      </div>
    </div>
  );
}
