'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import OrderHistory from './OrderHistory';
import AddressBook from './AddressBook';
import { supabase } from '@/lib/supabase';

function AccountContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialTab = searchParams?.get('tab') || 'profile';

  const [activeTab, setActiveTab] = useState(initialTab);
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  // Update active tab when URL param changes
  useEffect(() => {
    const tab = searchParams?.get('tab');
    if (tab && ['profile', 'orders', 'addresses', 'security'].includes(tab)) {
      setActiveTab(tab);
    }
  }, [searchParams]);

  // Profile Form States
  const [profileData, setProfileData] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: ''
  });
  const [profileMessage, setProfileMessage] = useState({ type: '', text: '' });
  const [profileLoading, setProfileLoading] = useState(false);

  // Password Form States
  const [passwordData, setPasswordData] = useState({
    currentPassword: '',
    password: '',
    confirmPassword: ''
  });
  const [passwordMessage, setPasswordMessage] = useState({ type: '', text: '' });
  const [passwordLoading, setPasswordLoading] = useState(false);

  useEffect(() => {
    async function checkUser() {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        router.push('/auth/login');
        return;
      }

      setUser(session.user);
      setProfileData({
        firstName: session.user.user_metadata?.first_name || '',
        lastName: session.user.user_metadata?.last_name || '',
        email: session.user.email || '',
        phone: session.user.phone || ''
      });
      setLoading(false);
    }
    checkUser();
  }, [router]);

  const handleUpdateProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setProfileLoading(true);
    setProfileMessage({ type: '', text: '' });

    try {
      const { error } = await supabase.auth.updateUser({
        data: {
          first_name: profileData.firstName,
          last_name: profileData.lastName,
          phone: profileData.phone // Storing phone in metadata for now
        }
      });

      if (error) throw error;
      setProfileMessage({ type: 'success', text: 'Profile updated successfully!' });
    } catch (err: any) {
      setProfileMessage({ type: 'error', text: err.message });
    } finally {
      setProfileLoading(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (passwordData.password !== passwordData.confirmPassword) {
      setPasswordMessage({ type: 'error', text: 'Passwords do not match' });
      return;
    }
    if (passwordData.password.length < 6) {
      setPasswordMessage({ type: 'error', text: 'Password must be at least 6 characters' });
      return;
    }

    setPasswordLoading(true);
    setPasswordMessage({ type: '', text: '' });

    try {
      // The server checks the current password (or a sign-in in the last 15
      // minutes) before changing it.
      const { data, error } = await supabase.auth.updateUser({
        password: passwordData.password,
        current_password: passwordData.currentPassword || undefined,
      } as any);
      if (error) throw error;
      setPasswordData({ currentPassword: '', password: '', confirmPassword: '' });
      // A password change ends every session of the account; the reply
      // carries a fresh one for this browser.
      const fresh = (data?.user as any)?.session;
      if (fresh?.access_token && fresh?.refresh_token) {
        const { error: sessionError } = await supabase.auth.setSession({
          access_token: fresh.access_token,
          refresh_token: fresh.refresh_token,
        });
        if (!sessionError) {
          setPasswordMessage({ type: 'success', text: 'Password updated successfully!' });
          return;
        }
      }
      await supabase.auth.signOut({ scope: 'local' });
      router.push('/auth/login');
      router.refresh();
    } catch (err: any) {
      setPasswordMessage({ type: 'error', text: err.message });
    } finally {
      setPasswordLoading(false);
    }
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    router.push('/auth/login');
    router.refresh();
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <i className="ri-loader-4-line animate-spin text-4xl text-gray-900"></i>
      </div>
    );
  }

  const quickActions = [
    {
      icon: 'ri-medal-line',
      title: 'Loyalty Program',
      description: 'Earn points and rewards',
      link: '/loyalty'
    },
    {
      icon: 'ri-user-add-line',
      title: 'Refer & Earn',
      description: 'Invite friends and earn rewards',
      link: '/referral'
    }
  ];

  const securityOptions = [
    {
      icon: 'ri-mail-check-line',
      title: 'Verify Email',
      description: user?.email,
      status: user?.email_confirmed_at ? 'verified' : 'unverified',
      link: '#' // /account/verify-email
    },
    {
      icon: 'ri-phone-line',
      title: 'Verify Phone',
      description: user?.phone || 'No phone added',
      status: user?.phone_confirmed_at ? 'verified' : 'unverified',
      link: '#' // /account/verify-phone
    }
  ];

  return (
    <>
      <div className="min-h-screen bg-gray-50 py-8 lg:py-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">

          {/* Header */}
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6 md:mb-8">
            <div className="flex items-center gap-3 md:gap-4 w-full md:w-auto">
              <div className="w-12 h-12 md:w-16 md:h-16 flex-shrink-0 rounded-full bg-gray-100 flex items-center justify-center text-gray-900 text-xl md:text-2xl font-bold shadow-inner border-2 border-white">
                {profileData.firstName?.[0] || user?.email?.[0]?.toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <h1 className="text-xl md:text-2xl font-bold text-gray-900 truncate pr-2">{profileData.firstName ? `Hello, ${profileData.firstName}!` : 'Welcome Back'}</h1>
                <p className="text-gray-500 text-sm font-medium truncate">{user?.email}</p>
              </div>
            </div>
            <button
              onClick={handleSignOut}
              className="flex items-center gap-2 px-5 py-2.5 bg-white border border-gray-200 text-gray-700 rounded-xl hover:bg-gray-50 hover:text-red-600 hover:border-red-200 transition-all font-medium shadow-sm w-full md:w-auto justify-center md:justify-start"
            >
              <i className="ri-logout-box-r-line"></i>
              Sign Out
            </button>
          </div>

          <div className="grid lg:grid-cols-4 gap-8">
            {/* Desktop Sidebar Navigation */}
            <div className="hidden lg:block lg:col-span-1">
              <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden sticky top-24">
                <nav className="p-2 space-y-1">
                  {[
                    { id: 'profile', icon: 'ri-user-settings-line', label: 'Profile Settings' },
                    { id: 'orders', icon: 'ri-shopping-bag-3-line', label: 'Order History' },
                    { id: 'addresses', icon: 'ri-map-pin-2-line', label: 'Addresses' },
                    { id: 'security', icon: 'ri-shield-keyhole-line', label: 'Security' }
                  ].map(tab => (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl font-medium transition-all text-left group ${activeTab === tab.id
                        ? 'bg-gray-50 text-gray-900 shadow-sm'
                        : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                        }`}
                    >
                      <i className={`${tab.icon} text-xl transition-colors ${activeTab === tab.id ? 'text-gray-900' : 'text-gray-400 group-hover:text-gray-600'}`}></i>
                      <span>{tab.label}</span>
                    </button>
                  ))}
                </nav>
              </div>
            </div>

            {/* Mobile Horizontal Navigation */}
            <div className="lg:hidden col-span-1 pb-2">
              <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
                {[
                  { id: 'profile', icon: 'ri-user-settings-line', label: 'Profile' },
                  { id: 'orders', icon: 'ri-shopping-bag-3-line', label: 'Orders' },
                  { id: 'addresses', icon: 'ri-map-pin-2-line', label: 'Address' },
                  { id: 'security', icon: 'ri-shield-keyhole-line', label: 'Security' }
                ].map(tab => (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`flex items-center gap-2 px-5 py-2.5 rounded-full font-medium whitespace-nowrap transition-all border shadow-sm ${activeTab === tab.id
                      ? 'bg-primary text-white border-gray-900 ring-2 ring-gray-100'
                      : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
                      }`}
                  >
                    <i className={tab.icon}></i>
                    <span>{tab.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Main Content Area */}
            <div className="lg:col-span-3">
              <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 sm:p-8 min-h-[500px]">
                {activeTab === 'profile' && (
                  <div className="max-w-2xl">
                    <h2 className="text-2xl font-bold text-gray-900 mb-2">Profile Information</h2>
                    <p className="text-gray-500 mb-8">Update your personal details and contact info.</p>

                    {profileMessage.text && (
                      <div className={`mb-6 p-4 rounded-xl flex items-start gap-3 ${profileMessage.type === 'success' ? 'bg-gray-50 text-gray-900 border border-gray-100' : 'bg-red-50 text-red-700 border border-red-100'}`}>
                        <i className={`text-xl mt-0.5 ${profileMessage.type === 'success' ? 'ri-checkbox-circle-line' : 'ri-error-warning-line'}`}></i>
                        <div>{profileMessage.text}</div>
                      </div>
                    )}

                    <form onSubmit={handleUpdateProfile} className="space-y-6">
                      <div className="grid md:grid-cols-2 gap-6">
                        <div className="space-y-2">
                          <label className="text-sm font-semibold text-gray-900">First Name</label>
                          <input
                            type="text"
                            value={profileData.firstName}
                            onChange={e => setProfileData({ ...profileData, firstName: e.target.value })}
                            className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:ring-4 focus:ring-gray-50 focus:border-gray-600 transition-all bg-gray-50 focus:bg-white"
                          />
                        </div>
                        <div className="space-y-2">
                          <label className="text-sm font-semibold text-gray-900">Last Name</label>
                          <input
                            type="text"
                            value={profileData.lastName}
                            onChange={e => setProfileData({ ...profileData, lastName: e.target.value })}
                            className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:ring-4 focus:ring-gray-50 focus:border-gray-600 transition-all bg-gray-50 focus:bg-white"
                          />
                        </div>
                      </div>

                      <div className="space-y-2">
                        <label className="text-sm font-semibold text-gray-900">Email Address</label>
                        <div className="relative">
                          <i className="ri-mail-line absolute left-4 top-1/2 -translate-y-1/2 text-gray-400"></i>
                          <input
                            type="email"
                            value={profileData.email}
                            disabled
                            className="w-full pl-11 pr-4 py-3 border-2 border-gray-100 bg-gray-50/50 rounded-xl text-gray-500 cursor-not-allowed"
                          />
                          <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs font-semibold bg-gray-200 text-gray-600 px-2 py-1 rounded">Read Only</span>
                        </div>
                      </div>

                      <div className="space-y-2">
                        <label className="text-sm font-semibold text-gray-900">Phone Number</label>
                        <div className="relative">
                          <i className="ri-phone-line absolute left-4 top-1/2 -translate-y-1/2 text-gray-400"></i>
                          <input
                            type="tel"
                            value={profileData.phone}
                            onChange={e => setProfileData({ ...profileData, phone: e.target.value })}
                            placeholder="+233 XX XXX XXXX"
                            className="w-full pl-11 pr-4 py-3 border-2 border-gray-200 rounded-xl focus:ring-4 focus:ring-gray-50 focus:border-gray-600 transition-all bg-gray-50 focus:bg-white"
                          />
                        </div>
                      </div>

                      <div className="pt-4">
                        <button
                          type="submit"
                          disabled={profileLoading}
                          className="px-8 py-3 bg-primary hover:bg-primary text-white rounded-xl font-semibold transition-all shadow-lg shadow-gray-900/20 active:scale-95 disabled:opacity-50 disabled:shadow-none"
                        >
                          {profileLoading ? 'Saving Info...' : 'Save Profile Information'}
                        </button>
                      </div>
                    </form>

                    <div className="mt-12 pt-12 border-t border-gray-100">
                      <h3 className="text-xl font-bold text-gray-900 mb-2">Change Password</h3>
                      <p className="text-gray-500 mb-6">Ensure your account uses a strong, unique password.</p>

                      {passwordMessage.text && (
                        <div className={`mb-6 p-4 rounded-xl flex items-start gap-3 ${passwordMessage.type === 'success' ? 'bg-gray-50 text-gray-900 border border-gray-100' : 'bg-red-50 text-red-700 border border-red-100'}`}>
                          <i className={`text-xl mt-0.5 ${passwordMessage.type === 'success' ? 'ri-checkbox-circle-line' : 'ri-error-warning-line'}`}></i>
                          <div>{passwordMessage.text}</div>
                        </div>
                      )}

                      <form onSubmit={handleChangePassword} className="space-y-5">
                        <div className="space-y-2">
                          <label className="text-sm font-semibold text-gray-900">Current Password</label>
                          <div className="relative">
                            <i className="ri-lock-password-line absolute left-4 top-1/2 -translate-y-1/2 text-gray-400"></i>
                            <input
                              type="password"
                              autoComplete="current-password"
                              value={passwordData.currentPassword}
                              onChange={e => setPasswordData({ ...passwordData, currentPassword: e.target.value })}
                              className="w-full pl-11 pr-4 py-3 border-2 border-gray-200 rounded-xl focus:ring-4 focus:ring-emerald-50 focus:border-emerald-500 transition-all bg-gray-50 focus:bg-white"
                            />
                          </div>
                        </div>
                        <div className="grid md:grid-cols-2 gap-6">
                          <div className="space-y-2">
                            <label className="text-sm font-semibold text-gray-900">New Password</label>
                            <div className="relative">
                              <i className="ri-lock-line absolute left-4 top-1/2 -translate-y-1/2 text-gray-400"></i>
                              <input
                                type="password"
                                value={passwordData.password}
                                onChange={e => setPasswordData({ ...passwordData, password: e.target.value })}
                                className="w-full pl-11 pr-4 py-3 border-2 border-gray-200 rounded-xl focus:ring-4 focus:ring-gray-50 focus:border-gray-600 transition-all bg-gray-50 focus:bg-white"
                              />
                            </div>
                          </div>
                          <div className="space-y-2">
                            <label className="text-sm font-semibold text-gray-900">Confirm Password</label>
                            <div className="relative">
                              <i className="ri-lock-check-line absolute left-4 top-1/2 -translate-y-1/2 text-gray-400"></i>
                              <input
                                type="password"
                                value={passwordData.confirmPassword}
                                onChange={e => setPasswordData({ ...passwordData, confirmPassword: e.target.value })}
                                className="w-full pl-11 pr-4 py-3 border-2 border-gray-200 rounded-xl focus:ring-4 focus:ring-gray-50 focus:border-gray-600 transition-all bg-gray-50 focus:bg-white"
                              />
                            </div>
                          </div>
                        </div>
                        <button
                          type="submit"
                          disabled={passwordLoading}
                          className="px-8 py-3 bg-primary hover:bg-primary text-white rounded-xl font-semibold transition-all shadow-lg shadow-gray-900/10 active:scale-95 disabled:opacity-50 disabled:shadow-none"
                        >
                          {passwordLoading ? 'Updating...' : 'Update Password'}
                        </button>
                      </form>
                    </div>
                  </div>
                )}

                {activeTab === 'orders' && <OrderHistory />}

                {activeTab === 'addresses' && <AddressBook />}

                {activeTab === 'security' && (
                  <div>
                    <h2 className="text-2xl font-bold text-gray-900 mb-6">Security Settings</h2>
                    <div className="grid md:grid-cols-2 gap-4">
                      {securityOptions.map((option, index) => (
                        <Link
                          key={index}
                          href={option.link}
                          className="flex items-center justify-between p-5 border border-gray-200 rounded-2xl hover:border-gray-600 hover:shadow-md transition-all group bg-white"
                        >
                          <div className="flex items-center gap-4">
                            <div className="w-12 h-12 bg-gray-50 rounded-full flex items-center justify-center group-hover:bg-gray-100 group-hover:text-gray-900 transition-colors">
                              <i className={`${option.icon} text-xl`}></i>
                            </div>
                            <div>
                              <h3 className="font-bold text-gray-900">{option.title}</h3>
                              <p className="text-sm text-gray-500">{option.description}</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-3">
                            {option.status === 'verified' && (
                              <span className="text-xs font-bold px-3 py-1 bg-gray-100 text-gray-900 rounded-full flex items-center gap-1">
                                <i className="ri-verified-badge-fill"></i> Verified
                              </span>
                            )}
                            {option.status === 'unverified' && (
                              <span className="text-xs font-bold px-3 py-1 bg-amber-100 text-amber-700 rounded-full flex items-center gap-1">
                                <i className="ri-error-warning-fill"></i> Verify
                              </span>
                            )}
                            <i className="ri-arrow-right-line text-gray-300 group-hover:text-gray-600 transition-colors"></i>
                          </div>
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

export default function AccountPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <i className="ri-loader-4-line animate-spin text-4xl text-gray-900"></i>
      </div>
    }>
      <AccountContent />
    </Suspense>
  );
}
