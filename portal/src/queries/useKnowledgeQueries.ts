import {
  useQuery,
  useMutation,
  useQueryClient,
  queryOptions,
  type QueryClient,
} from "@tanstack/react-query";
import { api } from "../services/apiClient";
import { queryKeys } from "./queryKeys";
import { toast } from "sonner";
import { normalizeWebsiteUrl } from "../lib/websiteUrl";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// --- Query Options ---

export type WebsiteCrawlNotice = {
  origin: string;
  skippedByRules: number;
  rulesUnreachable: boolean;
  hasPages: boolean;
};

type DocumentsQueryData = {
  documents: Any[];
  websiteCrawls: WebsiteCrawlNotice[];
};

type ImportWebsiteInput = {
  url: string;
  followLinks?: boolean;
  maxPages?: number;
  kbId?: string;
  extraUrls?: string[];
};

const POLL_MS = 5000;
export const WEBSITE_IMPORT_WATCH_MS = 2 * 60 * 1000;
const importWebsiteKey = ["knowledge", "importWebsite"] as const;

function importOrigin(url: string): string | null {
  try {
    return `${new URL(normalizeWebsiteUrl(url)).origin}/`;
  } catch {
    return null;
  }
}

type ImportWatch = { origin: string | null; before: string | null };

function noticeFor(
  notices: WebsiteCrawlNotice[] | undefined,
  origin: string | null,
): string | null {
  const notice = notices?.find((candidate) => candidate.origin === origin);
  return notice ? JSON.stringify(notice) : null;
}

function cachedNotices(
  queryClient: QueryClient,
  kbId: string | undefined,
): WebsiteCrawlNotice[] | undefined {
  if (!kbId) {
    return queryClient.getQueryData<DocumentsQueryData>(
      queryKeys.knowledge.documents(),
    )?.websiteCrawls;
  }
  return queryClient
    .getQueriesData<{
      kbId?: string | null;
      websiteCrawls?: WebsiteCrawlNotice[];
    }>({ queryKey: [...queryKeys.bots.all(), "knowledge"] })
    .find(([, data]) => data?.kbId === kbId)?.[1]?.websiteCrawls;
}

export function websiteImportPollInterval(
  queryClient: QueryClient,
  kbId: string | undefined,
  notices: WebsiteCrawlNotice[] | undefined,
): number | false {
  const watching = queryClient
    .getMutationCache()
    .findAll({ mutationKey: importWebsiteKey })
    .some((mutation) => {
      const input = mutation.state.variables as ImportWebsiteInput | undefined;
      const watch = mutation.state.context as ImportWatch | undefined;
      if (!input || !watch?.origin || input.kbId !== kbId) return false;
      if (mutation.state.status === "error") return false;
      if (Date.now() - mutation.state.submittedAt >= WEBSITE_IMPORT_WATCH_MS) {
        return false;
      }
      return noticeFor(notices, watch.origin) === watch.before;
    });
  return watching ? POLL_MS : false;
}

export const knowledgeOptions = {
  documents: () =>
    queryOptions({
      queryKey: queryKeys.knowledge.documents(),
      queryFn: async (): Promise<DocumentsQueryData> => {
        const res = await api.get<Any>("/knowledge/documents", {
          params: { limit: 100 },
        });
        if (Array.isArray(res)) {
          return { documents: res, websiteCrawls: [] };
        }
        return {
          documents: res?.documents ?? [],
          websiteCrawls: res?.websiteCrawls ?? [],
        };
      },
    }),
  stats: () =>
    queryOptions({
      queryKey: queryKeys.knowledge.stats(),
      queryFn: () => api.get<Any>("/knowledge/stats"),
    }),
};

// --- Query Hooks ---

export function useKnowledgeDocuments() {
  const queryClient = useQueryClient();
  return useQuery({
    ...knowledgeOptions.documents(),
    select: (data) => data.documents,
    // Auto-poll every 5s while any document is pending/processing
    refetchInterval: (query) => {
      const data = query.state.data;
      const hasProcessing = data?.documents.some(
        (d: Any) => d.status === "pending" || d.status === "processing",
      );
      if (hasProcessing) return POLL_MS;
      return websiteImportPollInterval(
        queryClient,
        undefined,
        data?.websiteCrawls,
      );
    },
  });
}

export function useWebsiteCrawlNotices() {
  return useQuery({
    ...knowledgeOptions.documents(),
    select: (data) => data.websiteCrawls ?? [],
  });
}


export function useKnowledgeStats() {
  return useQuery(knowledgeOptions.stats());
}

// --- Mutations ---

export function useCreateDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      type: string;
      title: string;
      sourceContent?: string;
      uploadToken?: string;
      metadata?: Record<string, Any>;
    }) => api.post("/knowledge/documents", data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.knowledge.documents(),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.stats() });
      toast.success("Document created");
    },
    onError: () => toast.error("Failed to create document"),
  });
}

export function useUpdateDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: {
        title?: string;
        sourceContent?: string;
        metadata?: Record<string, Any>;
      };
    }) => api.put(`/knowledge/documents/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.knowledge.documents(),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.stats() });
      toast.success("Document updated");
    },
    onError: () => toast.error("Failed to update document"),
  });
}

export function useDeleteDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/knowledge/documents/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.knowledge.documents(),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.stats() });
      toast.success("Document deleted");
    },
    onError: () => toast.error("Failed to delete document"),
  });
}

export type DiscoveredWebsiteHost = {
  host: string;
  url: string;
  sources: Array<"dns" | "ct">;
  autoCrawl?: boolean;
};

export function useDiscoverWebsiteHosts(url: string, enabled: boolean) {
  const normalized = normalizeWebsiteUrl(url);
  return useQuery({
    queryKey: ["knowledge", "discover", normalized],
    queryFn: () =>
      api.get<{
        origin: string;
        apex: string;
        hosts: DiscoveredWebsiteHost[];
      }>("/knowledge/documents/website/discover", { params: { url: normalized } }),
    enabled: enabled && /^https:\/\/[^\s]+$/i.test(normalized),
    staleTime: 60_000,
    retry: false,
  });
}

export function useImportWebsite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: importWebsiteKey,
    mutationFn: (data: ImportWebsiteInput) =>
      api.post("/knowledge/documents/website", {
        ...data,
        url: normalizeWebsiteUrl(data.url),
        extraUrls: data.extraUrls?.map(normalizeWebsiteUrl),
      }),
    onMutate: (data): ImportWatch => {
      const origin = importOrigin(data.url);
      return {
        origin,
        before: noticeFor(cachedNotices(queryClient, data.kbId), origin),
      };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.knowledge.documents(),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.stats() });
      toast.success("Website import started");
    },
    onError: () => toast.error("Failed to import website"),
  });
}

export function useRefreshWebsiteDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/knowledge/documents/${id}/refresh`),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.knowledge.documents(),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.stats() });
      toast.success("Website refresh started");
    },
    onError: () => toast.error("Failed to refresh website"),
  });
}

export function useRetryDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/knowledge/documents/${id}/retry`),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.knowledge.documents(),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.stats() });
      toast.success("Document reprocessing started");
    },
    onError: () => toast.error("Failed to retry document"),
  });
}

export function useUploadFile() {
  return useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      return api.post<{ uploadToken: string }>(
        "/knowledge/documents/upload",
        formData,
        {
          headers: { "Content-Type": "multipart/form-data" },
        },
      );
    },
    onError: () => toast.error("File upload failed"),
  });
}

export function useUpdateAiSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, Any>) =>
      api.patch("/tenants/me/ai-settings", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tenants.me() });
      queryClient.invalidateQueries({
        queryKey: [...queryKeys.tenants.me(), "ai-settings"],
      });
    },
    onError: () => toast.error("Failed to save AI settings"),
  });
}

export function useGetAiSettings(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: [...queryKeys.tenants.me(), "ai-settings"] as const,
    queryFn: () => api.get<Any>("/tenants/me/ai-settings"),
    enabled: options?.enabled ?? true,
  });
}


export interface StorageConnection {
  id: string;
  provider: string;
  accountEmail: string | null;
  reauthRequired: boolean;
  connectedByUserId: string;
  connectedByName: string | null;
  createdAt: string;
}

export interface StorageImportJobRow {
  id: string;
  fileId: string;
  provider: string;
  status: string;
  error: string | null;
  documentId: string | null;
  createdAt: string;
}

export function useStorageConnections() {
  return useQuery({
    queryKey: queryKeys.knowledge.storageConnections(),
    queryFn: async () => {
      const res = await api.get<{ connections: StorageConnection[] }>(
        "/knowledge/storage/connections",
      );
      return res.connections;
    },
  });
}

export function useStoragePickerConfig() {
  return useQuery({
    queryKey: queryKeys.knowledge.storagePicker(),
    queryFn: () =>
      api.get<{ clientId: string | null; pickerApiKey: string | null }>(
        "/knowledge/storage/google/picker-config",
      ),
  });
}

export function useStorageConnectUrl() {
  return useMutation({
    mutationFn: () =>
      api.get<{ startUrl: string }>("/knowledge/storage/google/connect-url"),
  });
}

export function useDisconnectStorage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/knowledge/storage/connections/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.knowledge.storageConnections(),
      });
    },
  });
}

export function useStartCloudImport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      storageConnectionId: string;
      files: Array<{
        id: string;
        name?: string;
        mimeType?: string;
        size?: number;
        driveId?: string;
      }>;
      googleAccessToken?: string;
      oneDriveAccessToken?: string;
      kbId?: string;
    }) => api.post<{
    jobs: StorageImportJobRow[];
    skipped?: Array<{ id: string; reason: string }>;
  }>("/knowledge/storage/import", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.storageJobs() });
      queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.documents() });
      queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.stats() });
    },
  });
}

export function useStorageImportJobs(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.knowledge.storageJobs(),
    queryFn: async () => {
      const res = await api.get<{ jobs: StorageImportJobRow[] }>(
        "/knowledge/storage/jobs",
      );
      return res.jobs;
    },
    enabled,
    refetchInterval: (query) => {
      const rows = query.state.data;
      const busy =
        Array.isArray(rows) &&
        rows.some(
          (j) => j.status !== "document_created" && j.status !== "failed",
        );
      return busy ? 3000 : false;
    },
  });
}


export function useOneDriveConnectUrl() {
  return useMutation({
    mutationFn: () =>
      api.get<{ startUrl: string }>("/knowledge/storage/onedrive/connect-url"),
  });
}

