import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Loader2, Cloud, Unplug } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/services/apiClient";
import {
  useStorageConnections,
  useStoragePickerConfig,
  useStorageConnectUrl,
  useStartCloudImport,
  useDisconnectStorage,
  useStorageImportJobs,
  useOneDriveConnectUrl,
  useKnowledgeStats,
  type StorageConnection,
} from "@/queries/useKnowledgeQueries";

declare global {
  interface Window {
    google?: {
      accounts?: {
        oauth2?: {
          initTokenClient: (opts: {
            client_id: string;
            scope: string;
            login_hint?: string;
            callback: (resp: { access_token?: string; error?: string }) => void;
          }) => { requestAccessToken: () => void };
        };
      };
      picker?: {
        PickerBuilder: new () => {
          addView: (view: unknown) => unknown;
          setOAuthToken: (token: string) => unknown;
          setDeveloperKey: (key: string) => unknown;
          setCallback: (cb: (data: PickerResponse) => void) => unknown;
          build: () => { setVisible: (v: boolean) => void };
        };
        ViewId: { DOCS: unknown };
        Response: { ACTION: string; DOCUMENTS: string };
        Action: { PICKED: string; CANCEL: string };
        Document: {
          ID: string;
          NAME: string;
          MIME_TYPE: string;
          SIZE_BYTES: string;
        };
      };
    };
    gapi?: { load: (name: string, cb: () => void) => void };
  }
}

interface PickerResponse {
  action: string;
  docs?: Array<{
    id: string;
    name?: string;
    mimeType?: string;
    sizeBytes?: number;
  }>;
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const el = document.createElement("script");
    el.src = src;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(el);
  });
}

export default function CloudImportPanel({
  onImported,
}: {
  onImported: () => void;
}) {
  const { t } = useTranslation();
  const connections = useStorageConnections();
  const pickerConfig = useStoragePickerConfig();
  const connectUrl = useStorageConnectUrl();
  const startImport = useStartCloudImport();
  const disconnect = useDisconnectStorage();
  const jobs = useStorageImportJobs(true);
  const [busy, setBusy] = useState(false);
  const stats = useKnowledgeStats();

  const googleConn = (connections.data ?? []).find(
    (c) => c.provider === "google_drive",
  );
  const oneDriveConn = (connections.data ?? []).find(
    (c) => c.provider === "onedrive",
  );
  const oneDriveConnect = useOneDriveConnectUrl();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("storage") === "connected") {
      connections.refetch();
      params.delete("storage");
      const next = `${window.location.pathname}?${params.toString()}`.replace(
        /\?$/,
        "",
      );
      window.history.replaceState({}, "", next);
    }
  }, [connections]);

  async function connectGoogle() {
    try {
      const { startUrl } = await connectUrl.mutateAsync();
      const popup = window.open(
        startUrl,
        "google-drive-connect",
        "width=520,height=720",
      );
      if (!popup) {
        toast.error(t("ai.knowledge.cloud.popupBlocked"));
        return;
      }
      const timer = window.setInterval(() => {
        if (!popup || popup.closed) {
          window.clearInterval(timer);
          connections.refetch();
        }
      }, 800);
    } catch {
      toast.error(t("ai.knowledge.cloud.connectFailed"));
    }
  }

  async function pickGoogleFiles(conn: StorageConnection) {
    const cfg = pickerConfig.data;
    const clientId = cfg?.clientId;
    const pickerApiKey = cfg?.pickerApiKey;
    if (!clientId || !pickerApiKey) {
      toast.error(t("ai.knowledge.cloud.pickerNotConfigured"));
      return;
    }
    setBusy(true);
    try {
      await loadScript("https://accounts.google.com/gsi/client");
      await loadScript("https://apis.google.com/js/api.js");
      await new Promise<void>((resolve, reject) => {
        if (!window.gapi) {
          reject(new Error("gapi missing"));
          return;
        }
        window.gapi.load("picker", () => resolve());
      });
      const token = await new Promise<string>((resolve, reject) => {
        const client = window.google?.accounts?.oauth2?.initTokenClient({
          client_id: clientId,
          scope: "https://www.googleapis.com/auth/drive.file openid email",
          login_hint: conn.accountEmail ?? undefined,
          callback: (resp) => {
            if (resp.error || !resp.access_token) {
              reject(new Error(resp.error || "token"));
              return;
            }
            resolve(resp.access_token);
          },
        });
        if (!client) {
          reject(new Error("GIS missing"));
          return;
        }
        client.requestAccessToken();
      });
      const files = await new Promise<
        Array<{ id: string; name?: string; mimeType?: string; size?: number }>
      >((resolve, reject) => {
        const picker = window.google?.picker;
        if (!picker) {
          reject(new Error("picker missing"));
          return;
        }
        const builder = new picker.PickerBuilder() as {
          addView: (view: unknown) => unknown;
          setOAuthToken: (token: string) => unknown;
          setDeveloperKey: (key: string) => unknown;
          setCallback: (cb: (data: PickerResponse) => void) => unknown;
          build: () => { setVisible: (v: boolean) => void };
        };
        builder.addView(picker.ViewId.DOCS);
        builder.setOAuthToken(token);
        builder.setDeveloperKey(pickerApiKey);
        builder.setCallback((data: PickerResponse) => {
          if (data.action === picker.Action.CANCEL) {
            resolve([]);
            return;
          }
          if (data.action === picker.Action.PICKED) {
            resolve(
              (data.docs ?? []).map((d) => ({
                id: d.id,
                name: d.name,
                mimeType: d.mimeType,
                size: d.sizeBytes,
              })),
            );
          }
        });
        builder.build().setVisible(true);
      });
      if (files.length === 0) return;
      const res = await startImport.mutateAsync({
        storageConnectionId: conn.id,
        files,
        googleAccessToken: token,
      });
      if (res.skipped?.length) {
        toast.message(t("ai.knowledge.cloud.someSkipped"), { description: `${res.skipped.length}` });
      } else {
        toast.success(t("ai.knowledge.cloud.importQueued"));
      }
      jobs.refetch();
      onImported();
    } catch {
      toast.error(t("ai.knowledge.cloud.importFailed"));
    } finally {
      setBusy(false);
    }
  }

  const pendingJobs = (jobs.data ?? []).filter(
    (j) => j.status !== "document_created" && j.status !== "failed",
  );

  async function pickOneDriveFiles(conn: StorageConnection) {
    try {
      setBusy(true);
      const cfg = await api.get<{ clientId: string | null }>(
        "/knowledge/storage/onedrive/picker-config",
      );
      const msClientId = cfg.clientId;
      if (!msClientId) {
        toast.error(t("ai.knowledge.cloud.pickerNotConfigured"));
        return;
      }
      const files = await new Promise<
        Array<{ id: string; name?: string; mimeType?: string; size?: number }>
      >((resolve) => {
        const popup = window.open(
          `/onedrive-picker.html?clientId=${encodeURIComponent(msClientId)}`,
          "onedrive-picker",
          "width=900,height=700",
        );
        function handler(event: MessageEvent) {
          if (event.origin !== window.location.origin) return;
          if (event.data?.type === "onedrive-files") {
            window.removeEventListener("message", handler);
            resolve(event.data.files ?? []);
            popup?.close();
          }
        }
        window.addEventListener("message", handler);
      });
      if (files.length === 0) return;
      await startImport.mutateAsync({
        storageConnectionId: conn.id,
        files,
      });
      toast.success(t("ai.knowledge.cloud.importQueued"));
      jobs.refetch();
      onImported();
    } catch {
      toast.error(t("ai.knowledge.cloud.importFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-text-secondary">
        {t("ai.knowledge.cloud.blurb")}
      </p>
      {typeof stats.data?.totalDocuments === "number" && (
        <p className="text-xs text-text-muted">
          {stats.data.totalDocuments} {t("ai.knowledge.cloud.slotsUsed")}
        </p>
      )}
      <div className="rounded-xl border border-border p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Cloud className="w-4 h-4 text-text-muted" />
            <div>
              <p className="text-sm font-medium">Google Drive</p>
              <p className="text-xs text-text-muted">
                {googleConn
                  ? googleConn.accountEmail || t("ai.knowledge.cloud.connected")
                  : t("ai.knowledge.cloud.notConnected")}
                {googleConn?.reauthRequired
                  ? ` — ${t("ai.knowledge.cloud.needsReauth")}`
                  : ""}
              </p>
            </div>
          </div>
          {googleConn ? (
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => pickGoogleFiles(googleConn)}
                disabled={busy || startImport.isPending}
              >
                {(busy || startImport.isPending) && (
                  <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                )}
                {t("ai.knowledge.cloud.importFiles")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => disconnect.mutate(googleConn.id)}
              >
                <Unplug className="w-4 h-4" />
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              size="sm"
              onClick={connectGoogle}
              disabled={connectUrl.isPending}
            >
              {connectUrl.isPending && (
                <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
              )}
              {t("ai.knowledge.cloud.connect")}
            </Button>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-border p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">OneDrive</p>
            <p className="text-xs text-text-muted">
              {oneDriveConn
                ? oneDriveConn.accountEmail || t("ai.knowledge.cloud.connected")
                : t("ai.knowledge.cloud.notConnected")}
            </p>
          </div>
          {oneDriveConn ? (
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                disabled={startImport.isPending || busy}
                onClick={() => pickOneDriveFiles(oneDriveConn)}
              >
                {(startImport.isPending || busy) && (
                  <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                )}
                {t("ai.knowledge.cloud.importFiles")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => disconnect.mutate(oneDriveConn.id)}
              >
                <Unplug className="w-4 h-4" />
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              size="sm"
              onClick={async () => {
                const { startUrl } = await oneDriveConnect.mutateAsync();
                window.open(
                  startUrl,
                  "onedrive-connect",
                  "width=520,height=720",
                );
              }}
              disabled={oneDriveConnect.isPending}
            >
              {t("ai.knowledge.cloud.connect")}
            </Button>
          )}
        </div>

        <p className="text-xs text-text-muted">
          {t("ai.knowledge.cloud.icloudLater")}
        </p>
      </div>
      {pendingJobs.length > 0 && (
        <ul className="text-xs text-text-muted space-y-1">
          {pendingJobs.slice(0, 8).map((j) => (
            <li key={j.id}>
              {j.fileId}: {j.status}
              {j.error ? ` — ${j.error}` : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
