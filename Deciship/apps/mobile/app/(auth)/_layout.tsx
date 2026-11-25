import { Stack } from 'expo-router';
import { useAuth } from '../../src/auth/AuthContext';
import { colors } from '../../src/ui/theme';

// Oturum kapanınca alfabetik ilk ekrana (davet) değil girişe düşülür.
export const unstable_settings = { anchor: 'login' };

export default function AuthLayout() {
  const { status } = useAuth();
  const signedIn = status === 'signedIn';
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg }, animation: 'slide_from_right' }}>
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="login" />
        <Stack.Screen name="join" />
      </Stack.Protected>
      <Stack.Protected guard={signedIn}>
        <Stack.Screen name="select-org" />
      </Stack.Protected>
    </Stack>
  );
}
