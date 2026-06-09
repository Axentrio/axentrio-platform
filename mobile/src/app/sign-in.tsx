import { useSignIn } from '@clerk/expo';
import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

type Step = 'credentials' | 'mfa';

export default function SignInScreen() {
  // Clerk Core 3 "Future" API. Password is the first factor; if the instance
  // requires a second factor we send + verify an email code, then finalize().
  const { signIn } = useSignIn();
  const [step, setStep] = useState<Step>('credentials');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submitCredentials = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const { error: pwError } = await signIn.password({ identifier: email.trim(), password });
      if (pwError) {
        setError(pwError.message ?? 'Sign in failed. Check your email and password.');
        return;
      }
      if (signIn.status === 'complete') {
        await signIn.finalize();
        return;
      }
      if (signIn.status === 'needs_second_factor') {
        const { error: sendError } = await signIn.mfa.sendEmailCode();
        if (sendError) {
          setError(sendError.message ?? 'Could not send a verification code.');
          return;
        }
        setStep('mfa');
        return;
      }
      setError('Additional verification is required. Finish signing in on the web portal.');
    } catch {
      setError('Sign in failed. Check your email and password.');
    } finally {
      setSubmitting(false);
    }
  };

  const submitCode = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const { error: verifyError } = await signIn.mfa.verifyEmailCode({ code: code.trim() });
      if (verifyError) {
        setError(verifyError.message ?? 'Invalid or expired code.');
        return;
      }
      if (signIn.status === 'complete') {
        await signIn.finalize();
      } else {
        setError('Could not complete sign in. Please try again.');
      }
    } catch {
      setError('Invalid or expired code.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView className="flex-1 bg-white">
      <View className="flex-1 justify-center gap-4 p-6">
        <Text className="text-3xl font-bold">Axentrio</Text>

        {step === 'credentials' ? (
          <>
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
              returnKeyType="go"
              onSubmitEditing={submitCredentials}
              className="rounded-xl border border-gray-300 px-4 py-3"
            />
            {error ? <Text className="text-red-600">{error}</Text> : null}
            <Pressable
              onPress={submitCredentials}
              disabled={submitting}
              className="items-center rounded-xl bg-brand py-3"
            >
              {submitting ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text className="font-semibold text-white">Sign in</Text>
              )}
            </Pressable>
          </>
        ) : (
          <>
            <Text className="text-base text-gray-600">
              Enter the verification code sent to your email.
            </Text>
            <TextInput
              value={code}
              onChangeText={setCode}
              placeholder="123456"
              keyboardType="number-pad"
              returnKeyType="go"
              onSubmitEditing={submitCode}
              className="rounded-xl border border-gray-300 px-4 py-3 text-center text-lg tracking-widest"
            />
            {error ? <Text className="text-red-600">{error}</Text> : null}
            <Pressable
              onPress={submitCode}
              disabled={submitting}
              className="items-center rounded-xl bg-brand py-3"
            >
              {submitting ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text className="font-semibold text-white">Verify</Text>
              )}
            </Pressable>
            <Pressable
              onPress={() => {
                setStep('credentials');
                setError(null);
                setCode('');
              }}
            >
              <Text className="text-center text-gray-500">Back</Text>
            </Pressable>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}
