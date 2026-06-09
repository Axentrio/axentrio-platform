import { Stack } from 'expo-router';

import { OrgGate } from '@/components/org-gate';
import { SocketProvider } from '@/providers/socket-provider';

/** Authenticated app shell: requires an active org, then opens one shared
 *  socket for all screens. */
export default function AppLayout() {
  return (
    <OrgGate>
      <SocketProvider>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="conversation/[id]" />
        </Stack>
      </SocketProvider>
    </OrgGate>
  );
}
