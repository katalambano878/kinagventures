import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';

export async function GET() {
  try {
    const { data } = await supabaseAdmin
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
