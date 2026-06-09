import type { ReactNode } from 'react';
import { View } from 'react-native';

export function Centered({ children }: { children: ReactNode }) {
  return <View className="flex-1 items-center justify-center p-6">{children}</View>;
}
