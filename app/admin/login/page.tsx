'use client';

import { useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { supabase, syncAdminSessionCookie } from '@/lib/supabase';
import { useRecaptcha } from '@/hooks/useRecaptcha';

function AdminLoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlError = searchParams?.get('error');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const { getToken, verifying } = useRecaptcha();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    // reCAPTCHA when configured; if it fails we still attempt login so misconfiguration doesn't lock you out
    await getToken('admin_login');

    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password
      });

      if (error) throw error;

      if (data.session) {
        // The server-side admin gate (middleware.ts) reads this cookie.
        syncAdminSessionCookie(data.session);
        // Full page navigation so the admin layout sees the new session (avoids client-side race)
        window.location.href = '/admin';
        return;
      }
    } catch (err: any) {
      const msg = err?.message || 'Login failed';
      setError(msg);
      if (err?.message?.toLowerCase().includes('email') && err?.message?.toLowerCase().includes('confirm')) {
        setError(`${msg} Check your inbox for the confirmation link, or turn off "Confirm email" in Supabase → Authentication → Providers → Email.`);
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 via-white to-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <Link href="/" className="inline-block">
            <img src="/logo-black.svg" alt="Store Logo" className="h-12 w-auto mx-auto" />
          </Link>
          <h1 className="text-3xl font-bold text-gray-900 mt-6 mb-2">Admin Login</h1>
          <p className="text-gray-600">Sign in to access the admin dashboard</p>
        </div>

        <div className="bg-white rounded-2xl shadow-xl p-8 border border-gray-100">
          {urlError === 'unauthorized' && (
            <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-lg flex items-start space-x-3">
              <i className="ri-shield-user-line text-amber-600 text-xl mt-0.5"></i>
              <div>
                <p className="text-amber-800 font-semibold">No admin access</p>
                <p className="text-amber-700 text-sm mt-1">
                  Your account does not have admin or staff rights. If you should have access, an existing admin must set your role in Supabase (Dashboard → Table Editor → profiles → set <code className="bg-amber-100 px-1 rounded">role</code> to <code className="bg-amber-100 px-1 rounded">admin</code> or <code className="bg-amber-100 px-1 rounded">staff</code>).
                </p>
              </div>
            </div>
          )}
          {urlError === 'no_profile' && (
            <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-lg flex items-start space-x-3">
              <i className="ri-user-search-line text-amber-600 text-xl mt-0.5"></i>
              <div>
                <p className="text-amber-800 font-semibold">Profile not found</p>
                <p className="text-amber-700 text-sm mt-1">
                  Your account exists but has no profile row. Run the SQL in the instructions below in Supabase SQL Editor to grant yourself admin access.
                </p>
              </div>
            </div>
          )}
          {error && (
            <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg flex items-start space-x-3">
              <i className="ri-error-warning-line text-red-600 text-xl mt-0.5"></i>
              <div>
                <p className="text-red-800 font-semibold">Login Failed</p>
                <p className="text-red-700 text-sm mt-1">{error}</p>
              </div>
            </div>
          )}

          <form onSubmit={handleLogin} className="space-y-5">
            <div>
              <label className="block text-sm font-semibold text-gray-900 mb-2">
                Email Address
              </label>
              <div className="relative">
                <i className="ri-mail-line absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 text-lg"></i>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full pl-12 pr-4 py-3 border-2 border-gray-300 rounded-lg focus:ring-2 focus:ring-gray-600 focus:border-gray-600"
                  placeholder="admin@example.com"
                  required
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-semibold text-gray-900 mb-2">
                Password
              </label>
              <div className="relative">
                <i className="ri-lock-line absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 text-lg"></i>
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full pl-12 pr-12 py-3 border-2 border-gray-300 rounded-lg focus:ring-2 focus:ring-gray-600 focus:border-gray-600"
                  placeholder="Enter your password"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 w-5 h-5 flex items-center justify-center"
                >
                  <i className={`${showPassword ? 'ri-eye-off-line' : 'ri-eye-line'} text-lg`}></i>
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={isLoading || verifying}
              className="w-full bg-primary hover:bg-primary text-white py-3 rounded-lg font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
            >
              {isLoading || verifying ? (
                <span className="flex items-center justify-center space-x-2">
                  <i className="ri-loader-4-line animate-spin"></i>
                  <span>{verifying ? 'Verifying...' : 'Signing in...'}</span>
                </span>
              ) : (
                'Sign In'
              )}
            </button>
          </form>

          {/* Admin access is restricted to users with admin/staff role */}
        </div>

        <details className="mt-6 bg-gray-50 rounded-xl border border-gray-200 overflow-hidden">
          <summary className="px-4 py-3 text-sm font-medium text-gray-700 cursor-pointer hover:bg-gray-100">
            How to grant admin access (Supabase)
          </summary>
          <div className="px-4 pb-4 text-sm text-gray-600 space-y-2">
            <p>1. Sign up or sign in once with the email you want as admin.</p>
            <p>2. In Supabase Dashboard go to SQL Editor and run one of these (replace the email):</p>
            <pre className="bg-primary text-gray-100 p-3 rounded-lg overflow-x-auto text-xs mt-2">
{`-- If you already have a profile (e.g. signed up on the store):
UPDATE profiles SET role = 'admin' WHERE email = 'your@email.com';

-- If you have no profile row (e.g. user created in Auth only):
INSERT INTO profiles (id, email, role)
SELECT id, email, 'admin' FROM auth.users WHERE email = 'your@email.com'
ON CONFLICT (id) DO UPDATE SET role = 'admin';`}
            </pre>
            <p>3. Sign in again at this page.</p>
          </div>
        </details>

        <div className="mt-6 text-center">
          <Link href="/" className="text-sm text-gray-600 hover:text-gray-900 transition-colors whitespace-nowrap">
            <i className="ri-arrow-left-line mr-2"></i>
            Back to Store
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function AdminLoginPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="w-10 h-10 border-2 border-gray-900 border-t-transparent rounded-full animate-spin" />
      </div>
    }>
      <AdminLoginForm />
    </Suspense>
  );
}
