import { NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const supabase = createServerSupabase('anon');
    const { data } = await supabase
      .from('store_settings')
      .select('value')
      .eq('key', 'maintenance_countdown_minutes')
      .single();
    const minutes = data?.value ? parseInt(String(data.value), 10) : 30;
    return NextResponse.json({ countdownMinutes: isNaN(minutes) ? 30 : Math.max(1, minutes) });
  } catch {
    return NextResponse.json({ countdownMinutes: 30 });
  }
}
