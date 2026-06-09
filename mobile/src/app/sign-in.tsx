import { useSignIn } from '@clerk/expo';
import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function SignInScreen() {
  // Clerk Core 3 "Future" API: one-step password sign-in, then finalize() to
  // set the active session. No setActive / isLoaded on this hook.
  const { signIn } = useSignIn();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const { error: passwordError } = await signIn.password({
        identifier: email.trim(),
        password,
      });
      if (passwordError) {
        setError(passwordError.message ?? 'Sign in failed. Check your email and password.');
        return;
      }
      if (signIn.status === 'complete') {
        await signIn.finalize();
      } else {
        setError('Additional verification is required. Finish signing in on the web portal.');
      }
    } catch {
      setError('Sign in failed. Check your email and password.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView className="flex-1 bg-white">
      <View className="flex-1 justify-center gap-4 p-6">
        <Text className="text-3xl font-bold">Axentrio</Text>
        <Text className="text-base text-gray-600">Sign in to manage your bot.</Text>

        <TextInput
          value={email}
          onChangeText={setEmail}
          placeholder="Email"
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          className="rounded-xl border border-gray-300 px-4 py-3"
        />
        <TextInput
          value={password}
          onChangeText={setPassword}
          placeholder="Password"
          secureTextEntry
          className="rounded-xl border border-gray-300 px-4 py-3"
        />

        {error ? <Text className="text-red-600">{error}</Text> : null}

        <Pressable
          onPress={onSubmit}
          disabled={submitting}
          className="items-center rounded-xl bg-brand py-3"
        >
          {submitting ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text className="font-semibold text-white">Sign in</Text>
          )}
        </Pressable>
      </View>
    </SafeAreaView>
  );
}
