import { Text, View } from 'react-native';

/** Placeholder for screens not yet implemented. */
export function ScreenStub({ title }: { title: string }) {
  return (
    <View className="flex-1 items-center justify-center bg-white p-6">
      <Text className="text-gray-400">{title} — coming soon</Text>
    </View>
  );
}
