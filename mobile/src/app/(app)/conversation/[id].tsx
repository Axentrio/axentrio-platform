import { Stack, useLocalSearchParams } from 'expo-router';

import { ScreenStub } from '@/components/screen-stub';

export default function ConversationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: 'Conversation' }} />
      <ScreenStub title={`Conversation ${id}`} />
    </>
  );
}
