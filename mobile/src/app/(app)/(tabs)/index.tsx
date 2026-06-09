import type { SessionStatus, SessionSummary } from '@axentrio/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useCallback, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { timeAgo } from '@/lib/format';
import { useSessions } from '@/hooks/use-sessions';
import { useSocketEvent } from '@/providers/socket-provider';

const FILTERS: { label: string; value?: SessionStatus }[] = [
  { label: 'All' },
  { label: 'Active', value: 'active' },
  { label: 'Handoff', value: 'handoff' },
];

export default function InboxScreen() {
  const router = useRouter();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<SessionStatus | undefined>(undefined);

  const { data, isLoading, isError, refetch, isRefetching } = useSessions(
    filter ? { status: filter } : undefined,
  );

  // Live inbox: any new message or handoff event refetches the session list.
  const invalidate = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['chats', 'sessions'] });
  }, [qc]);
  useSocketEvent('message:new', invalidate);
  useSocketEvent('handoff:requested', invalidate);
  useSocketEvent('handoff:assigned', invalidate);

  const sessions = data?.items ?? [];

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-white">
      <View className="flex-row gap-2 p-3">
        {FILTERS.map((f) => {
          const active = filter === f.value;
          return (
            <Pressable
              key={f.label}
              onPress={() => setFilter(f.value)}
              className={`rounded-full px-4 py-1.5 ${active ? 'bg-brand' : 'bg-gray-100'}`}
            >
              <Text className={active ? 'font-semibold text-white' : 'text-gray-700'}>
                {f.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {isLoading ? (
        <Centered>
          <ActivityIndicator />
        </Centered>
      ) : isError ? (
        <Centered>
          <Text className="text-red-600">Couldn’t load conversations.</Text>
        </Centered>
      ) : (
        <FlatList
          data={sessions}
          keyExtractor={(s) => s.id}
          contentContainerStyle={sessions.length === 0 ? { flexGrow: 1 } : undefined}
          refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => refetch()} />}
          ListEmptyComponent={
            <Centered>
              <Text className="text-gray-500">No conversations.</Text>
            </Centered>
          }
          renderItem={({ item }) => (
            <SessionRow
              session={item}
              onPress={() => router.push(`/conversation/${item.id}`)}
            />
          )}
        />
      )}
    </SafeAreaView>
  );
}

function SessionRow({
  session,
  onPress,
}: {
  session: SessionSummary;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} className="border-b border-gray-100 px-4 py-3">
      <View className="flex-row items-center justify-between">
        <Text className="text-base font-semibold" numberOfLines={1}>
          {session.userName}
        </Text>
        <Text className="text-xs text-gray-400">{timeAgo(session.lastMessageAt)}</Text>
      </View>
      <View className="mt-1 flex-row items-center justify-between gap-2">
        <Text className="flex-1 text-sm text-gray-500" numberOfLines={1}>
          {session.lastMessage ?? 'No messages yet'}
        </Text>
        <StatusBadge status={session.status} />
      </View>
    </Pressable>
  );
}

const STATUS_STYLE: Record<SessionStatus, string> = {
  handoff: 'bg-amber-100 text-amber-800',
  active: 'bg-green-100 text-green-800',
  waiting: 'bg-gray-100 text-gray-600',
  bot: 'bg-blue-100 text-blue-800',
  closed: 'bg-gray-100 text-gray-500',
};

function StatusBadge({ status }: { status: SessionStatus }) {
  return (
    <View className={`rounded-full px-2 py-0.5 ${STATUS_STYLE[status]}`}>
      <Text className={`text-[10px] font-semibold uppercase ${STATUS_STYLE[status]}`}>
        {status}
      </Text>
    </View>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <View className="flex-1 items-center justify-center p-6">{children}</View>;
}
