import { Redirect } from 'expo-router';
import { homeHref } from '../src/auth/access';
import { useAuth } from '../src/auth/AuthContext';

export default function Index() {
  const { status, me, needsOrgChoice } = useAuth();
  if (status !== 'signedIn') return <Redirect href="/login" />;
  if (needsOrgChoice) return <Redirect href="/select-org" />;
  return <Redirect href={homeHref(me)} />;
}
