export type SmsCreditLevel = 'healthy' | 'low' | 'empty';

export type DashboardSmsCredit =
  | { status: 'not_connected' }
  | { status: 'load_failed' }
  | { status: 'ok'; sms_left: number; level: SmsCreditLevel };