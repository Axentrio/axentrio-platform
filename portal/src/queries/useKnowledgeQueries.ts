import {
  useQuery,
  useMutation,
  useQueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { api } from "../services/apiClient";
import { queryKeys } from "./queryKeys";
import { toast } from "sonner";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// --- Query Options ---

export const knowledgeOptions = {
  documents: () =>
    queryOptions({
      queryKey: queryKeys.knowledge.documents(),
      queryFn: async () => {
        const res = await api.get<Any>("/knowledge/documents", {
          params: { limit: 100 },
        });
        return Array.isArray(res) ? res : (res?.documents ?? []);
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
  return useQuery({
    ...knowledgeOptions.documents(),
    // Auto-poll every 5s while any document is pending/processing
    refetchInterval: (query) => {
      const data = query.state.data;
      const hasProcessing =
        Array.isArray(data) &&
        data.some(
          (d: Any) => d.status === "pending" || d.status === "processing",
        );
      return hasProcessing ? 5000 : false;
    },
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
  return useQuery({
    queryKey: ["knowledge", "discover", url],
    queryFn: () =>
      api.get<{
        origin: string;
        apex: string;
        hosts: DiscoveredWebsiteHost[];
      }>("/knowledge/documents/website/discover", { params: { url } }),
    enabled: enabled && /^https:\/\/[^\s]+$/i.test(url),
    staleTime: 60_000,
    retry: false,
  });
}

export function useImportWebsite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      url: string;
      followLinks?: boolean;
      maxPages?: number;
      kbId?: string;
      extraUrls?: string[];
    }) => api.post("/knowledge/documents/website", data),
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

