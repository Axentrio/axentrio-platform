import type { Lead } from '@axentrio/contracts';
import { useRouter } from 'expo-router';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Centered } from '@/components/centered';
import { timeAgo } from '@/lib/format';
import { useLeads } from '@/hooks/use-leads';

export default function LeadsScreen() {
  const router = useRouter();
  const {
    data,
    isLoading,
    isError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    refetch,
    isRefetching,
  } = useLeads();

  const leads = data?.pages.flatMap((p) => p.leads) ?? [];

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-white">
      {isLoading ? (
        <Centered><ActivityIndicator /></Centered>
      ) : isError ? (
        <Centered><Text className="text-red-600">Couldn’t load leads.</Text></Centered>
      ) : (
        <FlatList
          data={leads}
          keyExtractor={(l) => l.id}
          contentContainerStyle={leads.length === 0 ? { flexGrow: 1 } : undefined}
          onEndReachedThreshold={0.4}
          onEndReached={() => {
            if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
          }}
          refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => refetch()} />}
          ListEmptyComponent={<Centered><Text className="text-gray-500">No leads yet.</Text></Centered>}
          ListFooterComponent={
            isFetchingNextPage ? (
              <View className="py-4">
                <ActivityIndicator />
              </View>
            ) : null
          }
          renderItem={({ item }) => (
            <LeadRow
              lead={item}
              onPress={() => {
                if (item.sessionId) router.push(`/conversation/${item.sessionId}`);
              }}
            />
          )}
        />
      )}
    </SafeAreaView>
  );
}

function LeadRow({ lead, onPress }: { lead: Lead; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!lead.sessionId}
      className="border-b border-gray-100 px-4 py-3"
    >
      <View className="flex-row items-center justify-between">
        <Text className="text-base font-semibold" numberOfLines={1}>
          {lead.name}
        </Text>
        <Text className="text-xs text-gray-400">{timeAgo(lead.createdAt)}</Text>
      </View>
      <Text className="text-sm text-gray-500" numberOfLines={1}>
        {lead.email}
        {lead.phone ? ` · ${lead.phone}` : ''}
      </Text>
      <Text className="mt-0.5 text-[10px] uppercase text-gray-400">{lead.source}</Text>
    </Pressable>
  );
}
