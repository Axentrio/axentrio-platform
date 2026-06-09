import { useAuth } from '@clerk/expo';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { OrgGate } from '@/components/org-gate';
import { useAuthMe } from '@/hooks/use-auth-me';

function HomeContent() {
  const { data, isLoading, error } = useAuthMe();

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center">
        <ActivityIndicator />
      </View>
    );
  }

  if (error || !data) {
    return (
      <View className="flex-1 items-center justify-center">
        <Text className="text-red-600">Couldn’t load your account.</Text>
      </View>
    );
  }

  return (
    <View className="gap-2">
      <Text className="text-2xl font-bold">{data.tenantName}</Text>
      <Text className="text-base text-gray-600">{data.email}</Text>
      <View className="self-start rounded-full bg-brand px-3 py-1">
        <Text className="text-xs font-semibold uppercase text-white">{data.role}</Text>
      </View>
    </View>
  );
}

export default function HomeScreen() {
  const { signOut } = useAuth();

  return (
    <SafeAreaView className="flex-1 bg-white">
      <OrgGate>
        <View className="flex-1 justify-between p-6">
          <HomeContent />
          <Pressable
            onPress={() => signOut()}
            className="items-center rounded-xl bg-gray-900 py-3"
          >
            <Text className="font-semibold text-white">Sign out</Text>
          </Pressable>
        </View>
      </OrgGate>
    </SafeAreaView>
  );
}
