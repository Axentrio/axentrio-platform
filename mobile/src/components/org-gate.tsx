import { useAuth, useOrganizationList } from '@clerk/expo';
import { useEffect, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

/**
 * Ensures an active organization before rendering children. The backend keys
 * every request on org context, so we must have an active org. Auto-selects
 * when the operator belongs to exactly one org; otherwise shows a picker.
 */
export function OrgGate({ children }: { children: ReactNode }) {
  const { isLoaded: authLoaded, orgId } = useAuth();
  const { isLoaded, userMemberships, setActive } = useOrganizationList({
    userMemberships: true,
  });

  const memberships = userMemberships?.data ?? [];

  useEffect(() => {
    if (!isLoaded || orgId || !setActive) return;
    if (memberships.length === 1) {
      void setActive({ organization: memberships[0].organization.id });
    }
  }, [isLoaded, orgId, memberships, setActive]);

  if (!authLoaded || !isLoaded) {
    return (
      <Centered>
        <ActivityIndicator />
      </Centered>
    );
  }

  if (orgId) {
    return <>{children}</>;
  }

  if (memberships.length === 0) {
    return (
      <Centered>
        <Text className="text-center text-gray-600">
          Your account isn’t a member of any organization yet. Ask an admin to add you.
        </Text>
      </Centered>
    );
  }

  return (
    <View className="flex-1 justify-center gap-3 p-6">
      <Text className="text-lg font-semibold">Choose an organization</Text>
      {memberships.map((m) => (
        <Pressable
          key={m.organization.id}
          onPress={() => setActive?.({ organization: m.organization.id })}
          className="rounded-xl border border-gray-200 p-4"
        >
          <Text className="text-base font-medium">{m.organization.name}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <View className="flex-1 items-center justify-center p-6">{children}</View>;
}
