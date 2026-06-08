import { useMutation, useQuery, useQueryClient, queryOptions } from '@tanstack/react-query';
import { api } from '../services/apiClient';
import { queryKeys } from './queryKeys';

export interface FaqTranslation {
  en: string;
  nl?: string;
  fr?: string;
}

export interface FaqItem {
  id: string;
  sectionId: string;
  slug: string;
  position: number;
  question: FaqTranslation;
  answer: FaqTranslation;
}

export interface FaqSection {
  id: string;
  position: number;
  isReserved: boolean;
  titles: FaqTranslation;
  items: FaqItem[];
}

export interface FaqTree {
  sections: FaqSection[];
}

interface CreateSectionInput {
  id: string;
  titles: FaqTranslation;
}

interface UpdateSectionInput {
  titles?: FaqTranslation;
}

interface CreateItemInput {
  slug: string;
  question: FaqTranslation;
  answer: FaqTranslation;
}

interface UpdateItemInput {
  slug?: string;
  sectionId?: string;
  question?: FaqTranslation;
  answer?: FaqTranslation;
}

interface ReorderInput {
  sections?: Array<{ id: string; position: number }>;
  items?: Array<{ id: string; sectionId: string; position: number }>;
}

const faqOptions = {
  tree: () =>
    queryOptions({
      queryKey: queryKeys.faq.tree(),
      queryFn: () => api.get<FaqTree>('/faq'),
    }),
};

export function useFaq() {
  return useQuery(faqOptions.tree());
}

function useInvalidateFaq() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.faq.all() });
}

export function useCreateFaqSection() {
  const invalidate = useInvalidateFaq();
  return useMutation({
    mutationFn: (input: CreateSectionInput) => api.post<FaqSection>('/faq/sections', input),
    onSuccess: invalidate,
  });
}

export function useUpdateFaqSection() {
  const invalidate = useInvalidateFaq();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string } & UpdateSectionInput) =>
      api.patch<FaqSection>(`/faq/sections/${id}`, patch),
    onSuccess: invalidate,
  });
}

export function useDeleteFaqSection() {
  const invalidate = useInvalidateFaq();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/faq/sections/${id}`),
    onSuccess: invalidate,
  });
}

export function useCreateFaqItem() {
  const invalidate = useInvalidateFaq();
  return useMutation({
    mutationFn: ({ sectionId, ...input }: { sectionId: string } & CreateItemInput) =>
      api.post<FaqItem>(`/faq/sections/${sectionId}/items`, input),
    onSuccess: invalidate,
  });
}

export function useUpdateFaqItem() {
  const invalidate = useInvalidateFaq();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string } & UpdateItemInput) =>
      api.patch<FaqItem>(`/faq/items/${id}`, patch),
    onSuccess: invalidate,
  });
}

export function useDeleteFaqItem() {
  const invalidate = useInvalidateFaq();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/faq/items/${id}`),
    onSuccess: invalidate,
  });
}

/**
 * Reorder is optimistic: we flip the cached tree to the requested arrangement
 * immediately, fire the mutation in the background, and only refetch if the
 * server rejects. This makes ↑/↓ feel instant even against a remote DB.
 */
export function useReorderFaq() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ReorderInput) => api.post<void>('/faq/reorder', input),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.faq.tree() });
      const previous = queryClient.getQueryData<FaqTree>(queryKeys.faq.tree());
      if (!previous) return { previous };

      const sectionPos = new Map<string, number>();
      input.sections?.forEach((s) => sectionPos.set(s.id, s.position));
      const itemPos = new Map<string, { position: number; sectionId: string }>();
      input.items?.forEach((it) => itemPos.set(it.id, { position: it.position, sectionId: it.sectionId }));

      const nextSections = previous.sections
        .map((s) => ({ ...s, position: sectionPos.get(s.id) ?? s.position }))
        .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));

      const itemsBySection = new Map<string, FaqItem[]>();
      for (const s of previous.sections) {
        for (const it of s.items) {
          const patch = itemPos.get(it.id);
          const updated = patch ? { ...it, position: patch.position, sectionId: patch.sectionId } : it;
          const arr = itemsBySection.get(updated.sectionId) ?? [];
          arr.push(updated);
          itemsBySection.set(updated.sectionId, arr);
        }
      }
      for (const arr of itemsBySection.values()) {
        arr.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
      }

      const next: FaqTree = {
        sections: nextSections.map((s) => ({ ...s, items: itemsBySection.get(s.id) ?? [] })),
      };
      queryClient.setQueryData(queryKeys.faq.tree(), next);
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) {
        queryClient.setQueryData(queryKeys.faq.tree(), ctx.previous);
      }
    },
    // Resync with the server after each mutation. Cheap on a 13-section tree
    // and guarantees the cache reflects authoritative state — important when
    // a user rapid-fires multiple reorders before the first round-trips.
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.faq.all() }),
  });
}
