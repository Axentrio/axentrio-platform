import { useAuth } from '@clerk/expo';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuthMe } from '@/hooks/use-auth-me';

export default function SettingsScreen() {
  const { signOut } = useAuth();
  const { data, isLoading, error } = useAuthMe();

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-white">
      <View className="flex-1 justify-between p-6">
        <View className="gap-2">
          {isLoading ? (
            <ActivityIndicator />
          ) : error || !data ? (
            <Text className="text-red-600">Couldn’t load your account.</Text>
          ) : (
            <>
              <Text className="text-2xl font-bold">{data.tenantName}</Text>
              <Text className="text-base text-gray-600">{data.email}</Text>
              <View className="self-start rounded-full bg-brand px-3 py-1">
                <Text className="text-xs font-semibold uppercase text-white">{data.role}</Text>
              </View>
            </>
          )}
        </View>

        <Pressable
          onPress={() => signOut()}
          className="items-center rounded-xl bg-gray-900 py-3"
        >
          <Text className="font-semibold text-white">Sign out</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}
