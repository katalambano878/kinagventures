import AdminDashboardClient from './AdminDashboardClient';
import { getDashboardSmsCredit } from '@/lib/sms-credit-cache';

export const dynamic = 'force-dynamic';

export default async function AdminDashboardPage() {
  const smsCredit = await getDashboardSmsCredit();
  return <AdminDashboardClient smsCredit={smsCredit} />;
}