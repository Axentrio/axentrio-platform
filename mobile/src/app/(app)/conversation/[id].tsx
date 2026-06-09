import type { Conversation, ConversationMessage } from '@axentrio/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { draftStore } from '@/lib/draft-store';
import { timeAgo } from '@/lib/format';
import { useApi } from '@/providers/api-provider';
import { useConversation } from '@/hooks/use-conversation';
import { useSocket, useSocketEvent } from '@/providers/socket-provider';

export default function ConversationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const qc = useQueryClient();
  const api = useApi();
  const socket = useSocket();

  const { data: conv, isLoading, isError } = useConversation(id);
  const sessionId = conv?.sessionId;

  const [input, setInput] = useState('');

  // Restore the draft once we know the session.
  useEffect(() => {
    if (sessionId) setInput(draftStore.get(sessionId));
  }, [sessionId]);

  // Join the session room for live messages; leave on unmount.
  useEffect(() => {
    if (!socket || !sessionId) return;
    socket.emit('agent:join', { sessionId });
    return () => {
      socket.emit('agent:leave', { sessionId });
    };
  }, [socket, sessionId]);

  // Any message event for this session refetches the conversation.
  const refetchOnSession = useCallback(
    (payload: { sessionId?: string }) => {
      if (payload?.sessionId && payload.sessionId === sessionId) {
        void qc.invalidateQueries({ queryKey: ['chats', id] });
      }
    },
    [qc, id, sessionId],
  );
  useSocketEvent('message:new', refetchOnSession);
  useSocketEvent('message:receive', refetchOnSession);

  const invalidateAll = () => {
    void qc.invalidateQueries({ queryKey: ['chats', id] });
    void qc.invalidateQueries({ queryKey: ['chats', 'sessions'] });
  };
  const accept = useMutation({
    mutationFn: () => api.acceptHandoff(sessionId!),
    onSuccess: invalidateAll,
  });
  const returnToBot = useMutation({
    mutationFn: () => api.returnHandoff(sessionId!),
    onSuccess: invalidateAll,
  });
  const close = useMutation({
    mutationFn: () => api.closeConversation(id),
    onSuccess: invalidateAll,
  });

  const onSend = () => {
    const content = input.trim();
    if (!content || !socket || !sessionId) return;
    socket.emit('message:send', { sessionId, content, type: 'text' });
    setInput('');
    draftStore.set(sessionId, '');
  };

  const onChangeText = (value: string) => {
    setInput(value);
    if (sessionId) draftStore.set(sessionId, value);
  };

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-white">
      <Stack.Screen options={{ headerShown: true, title: 'Conversation' }} />

      {isLoading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator />
        </View>
      ) : isError || !conv ? (
        <View className="flex-1 items-center justify-center p-6">
          <Text className="text-red-600">Couldn’t load this conversation.</Text>
        </View>
      ) : (
        <KeyboardAvoidingView
          className="flex-1"
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <HandoffBar
            conv={conv}
            onAccept={() => accept.mutate()}
            onReturn={() => returnToBot.mutate()}
            onClose={() => close.mutate()}
            busy={accept.isPending || returnToBot.isPending || close.isPending}
          />

          <FlatList
            data={conv.messages}
            keyExtractor={(m) => m.id}
            contentContainerStyle={{ padding: 12, gap: 8 }}
            renderItem={({ item }) => <MessageBubble message={item} />}
          />

          <View className="flex-row items-end gap-2 border-t border-gray-100 p-2">
            <TextInput
              value={input}
              onChangeText={onChangeText}
              placeholder="Type a reply…"
              multiline
              className="max-h-28 flex-1 rounded-2xl border border-gray-300 px-4 py-2"
            />
            <Pressable
              onPress={onSend}
              disabled={!input.trim() || !socket}
              className={`items-center justify-center rounded-full px-4 py-3 ${
                input.trim() && socket ? 'bg-brand' : 'bg-gray-300'
              }`}
            >
              <Text className="font-semibold text-white">Send</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  );
}

function HandoffBar({
  conv,
  onAccept,
  onReturn,
  onClose,
  busy,
}: {
  conv: Conversation;
  onAccept: () => void;
  onReturn: () => void;
  onClose: () => void;
  busy: boolean;
}) {
  if (conv.status === 'handoff') {
    return (
      <Bar>
        <Text className="flex-1 text-sm text-amber-800">Handoff requested</Text>
        <Action label="Accept" onPress={onAccept} disabled={busy} />
      </Bar>
    );
  }
  if (conv.status === 'active') {
    return (
      <Bar>
        <Text className="flex-1 text-sm text-gray-600">You’re handling this chat</Text>
        <Action label="Return to bot" onPress={onReturn} disabled={busy} subtle />
        <Action label="Close" onPress={onClose} disabled={busy} />
      </Bar>
    );
  }
  return null;
}

function Bar({ children }: { children: React.ReactNode }) {
  return (
    <View className="flex-row items-center gap-2 border-b border-gray-100 bg-gray-50 px-4 py-2">
      {children}
    </View>
  );
}

function Action({
  label,
  onPress,
  disabled,
  subtle,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  subtle?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      className={`rounded-lg px-3 py-1.5 ${subtle ? 'bg-gray-200' : 'bg-brand'}`}
    >
      <Text className={subtle ? 'text-gray-800' : 'font-semibold text-white'}>{label}</Text>
    </Pressable>
  );
}

function MessageBubble({ message }: { message: ConversationMessage }) {
  const isAgent = message.sender === 'agent';
  return (
    <View className={`max-w-[80%] ${isAgent ? 'self-end' : 'self-start'}`}>
      <View
        className={`rounded-2xl px-3 py-2 ${isAgent ? 'bg-brand' : 'bg-gray-100'}`}
      >
        <Text className={isAgent ? 'text-white' : 'text-gray-900'}>{message.content}</Text>
      </View>
      <Text
        className={`mt-0.5 text-[10px] text-gray-400 ${isAgent ? 'text-right' : 'text-left'}`}
      >
        {timeAgo(message.createdAt)}
      </Text>
    </View>
  );
}
