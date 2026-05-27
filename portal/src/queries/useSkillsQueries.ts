import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, extractApiErrorMessage } from '../services/apiClient';
import { queryKeys } from './queryKeys';
import { toast } from 'sonner';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

interface Skill {
  name: string;
  description?: string;
  enabled?: boolean;
  [key: string]: Any;
}

interface SkillsResponse {
  skills: Skill[];
}

export function useGetSkills() {
  return useQuery({
    queryKey: queryKeys.skills.list(),
    queryFn: () => api.get<SkillsResponse>('/tenants/me/skills'),
  });
}

export function useCreateSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Any) => api.post<Skill>('/tenants/me/skills', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.skills.list() });
      toast.success('Skill created');
    },
    onError: (err: Any) => {
      const msg =
        extractApiErrorMessage(err) ??
        (err instanceof Error ? err.message : undefined) ??
        'Failed to create skill';
      toast.error(msg);
    },
  });
}

export function useUpdateSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, data }: { name: string; data: Any }) =>
      api.put<Skill>(`/tenants/me/skills/${name}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.skills.list() });
      toast.success('Skill updated');
    },
    onError: (err: Any) => {
      const msg =
        extractApiErrorMessage(err) ??
        (err instanceof Error ? err.message : undefined) ??
        'Failed to update skill';
      toast.error(msg);
    },
  });
}

export function useDeleteSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.delete(`/tenants/me/skills/${name}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.skills.list() });
      toast.success('Skill deleted');
    },
    onError: (err: Any) => {
      const msg =
        extractApiErrorMessage(err) ??
        (err instanceof Error ? err.message : undefined) ??
        'Failed to delete skill';
      toast.error(msg);
    },
  });
}
