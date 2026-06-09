import type { AppNotification } from '@axentrio/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Centered } from '@/components/centered';
import { timeAgo } from '@/lib/format';
import { useApi } from '@/providers/api-provider';
import { useNotifications } from '@/hooks/use-notifications';

export default function AlertsScreen() {
  const qc = useQueryClient();
  const api = useApi();
  const { data, isLoading, isError, refetch, isRefetching } = useNotifications();

  const items = data?.items ?? [];
  const unread = data?.unreadCount ?? items.filter((n) => !n.read).length;

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['notifications'] });
  };
  const markRead = useMutation({
    mutationFn: (id: string) => api.markNotificationRead(id),
    onSuccess: invalidate,
  });
  const markAll = useMutation({
    mutationFn: () => api.markAllNotificationsRead(),
    onSuccess: invalidate,
  });

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-white">
      <View className="flex-row items-center justify-between p-3">
        <Text className="text-sm text-gray-500">{unread} unread</Text>
        <Pressable onPress={() => markAll.mutate()} disabled={markAll.isPending || unread === 0}>
          <Text className={unread === 0 ? 'text-gray-300' : 'font-semibold text-brand'}>
            Mark all read
          </Text>
        </Pressable>
      </View>

      {isLoading ? (
        <Centered><ActivityIndicator /></Centered>
      ) : isError ? (
        <Centered><Text className="text-red-600">Couldn’t load alerts.</Text></Centered>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(n) => n.id}
          contentContainerStyle={items.length === 0 ? { flexGrow: 1 } : undefined}
          refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => refetch()} />}
          ListEmptyComponent={<Centered><Text className="text-gray-500">No alerts.</Text></Centered>}
          renderItem={({ item }) => (
            <NotificationRow
              notification={item}
              onPress={() => {
                if (!item.read) markRead.mutate(item.id);
              }}
            />
          )}
        />
      )}
    </SafeAreaView>
  );
}

function NotificationRow({
  notification,
  onPress,
}: {
  notification: AppNotification;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} className="flex-row gap-3 border-b border-gray-100 px-4 py-3">
      <View className={`mt-1.5 h-2 w-2 rounded-full ${notification.read ? 'bg-transparent' : 'bg-brand'}`} />
      <View className="flex-1">
        <View className="flex-row items-center justify-between">
          <Text
            className={`text-base ${notification.read ? 'text-gray-700' : 'font-semibold text-gray-900'}`}
            numberOfLines={1}
          >
            {notification.title}
          </Text>
          <Text className="text-xs text-gray-400">{timeAgo(notification.createdAt)}</Text>
        </View>
        <Text className="text-sm text-gray-500" numberOfLines={2}>
          {notification.message}
        </Text>
      </View>
    </Pressable>
  );
}
