import type { Booking, BookingStatus } from '@axentrio/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Centered } from '@/components/centered';
import { formatDateTime } from '@/lib/format';
import { useApi } from '@/providers/api-provider';
import { useBookings } from '@/hooks/use-bookings';

type BookingsView = 'requests' | 'upcoming' | 'past';
const VIEWS: { label: string; value: BookingsView }[] = [
  { label: 'Requests', value: 'requests' },
  { label: 'Upcoming', value: 'upcoming' },
  { label: 'Past', value: 'past' },
];

export default function BookingsScreen() {
  const qc = useQueryClient();
  const api = useApi();
  const [view, setView] = useState<BookingsView>('requests');

  // Real API filters by status; upcoming/past are split client-side by time.
  const status: BookingStatus = view === 'requests' ? 'request_created' : 'confirmed';
  const { data, isLoading, isError, refetch, isRefetching } = useBookings({ status });

  const now = Date.now();
  const items = (data?.items ?? []).filter((b) => {
    const t = new Date(b.startUtc).getTime();
    if (view === 'upcoming') return t >= now;
    if (view === 'past') return t < now;
    return true;
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['scheduler', 'bookings'] });
  };
  const accept = useMutation({ mutationFn: (id: string) => api.acceptBooking(id), onSuccess: invalidate });
  const decline = useMutation({ mutationFn: (id: string) => api.declineBooking(id), onSuccess: invalidate });
  const busy = accept.isPending || decline.isPending;

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-white">
      <View className="flex-row gap-2 p-3">
        {VIEWS.map((v) => {
          const active = view === v.value;
          return (
            <Pressable
              key={v.value}
              onPress={() => setView(v.value)}
              className={`rounded-full px-4 py-1.5 ${active ? 'bg-brand' : 'bg-gray-100'}`}
            >
              <Text className={active ? 'font-semibold text-white' : 'text-gray-700'}>{v.label}</Text>
            </Pressable>
          );
        })}
      </View>

      {isLoading ? (
        <Centered><ActivityIndicator /></Centered>
      ) : isError ? (
        <Centered><Text className="text-red-600">Couldn’t load bookings.</Text></Centered>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(b) => b.id}
          contentContainerStyle={items.length === 0 ? { flexGrow: 1 } : undefined}
          refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => refetch()} />}
          ListEmptyComponent={<Centered><Text className="text-gray-500">Nothing here.</Text></Centered>}
          renderItem={({ item }) => (
            <BookingRow
              booking={item}
              isRequest={view === 'requests'}
              onAccept={() => accept.mutate(item.id)}
              onDecline={() => decline.mutate(item.id)}
              busy={busy}
            />
          )}
        />
      )}
    </SafeAreaView>
  );
}

function BookingRow({
  booking,
  isRequest,
  onAccept,
  onDecline,
  busy,
}: {
  booking: Booking;
  isRequest: boolean;
  onAccept: () => void;
  onDecline: () => void;
  busy: boolean;
}) {
  return (
    <View className="border-b border-gray-100 px-4 py-3">
      <Text className="text-base font-semibold">{booking.attendeeName ?? 'Booking'}</Text>
      <Text className="text-sm text-gray-500">{formatDateTime(booking.startUtc)}</Text>
      {booking.attendeeEmail ? (
        <Text className="text-xs text-gray-400">{booking.attendeeEmail}</Text>
      ) : null}
      {isRequest ? (
        <View className="mt-2 flex-row gap-2">
          <Pressable onPress={onAccept} disabled={busy} className="rounded-lg bg-brand px-3 py-1.5">
            <Text className="font-semibold text-white">Accept</Text>
          </Pressable>
          <Pressable onPress={onDecline} disabled={busy} className="rounded-lg bg-gray-200 px-3 py-1.5">
            <Text className="text-gray-800">Decline</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}
