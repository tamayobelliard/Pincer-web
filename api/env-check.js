// Warn if development environment is pointed at production Supabase
const PROD_SUPABASE = 'tcwujslibopzfyufhjsr.supabase.co';

let warned = false;

export function checkEnvSafety() {
  if (warned) return;
  const nodeEnv = process.env.NODE_ENV || '';
  const supabaseUrl = process.env.SUPABASE_URL || '';

  if (nodeEnv === 'development' && supabaseUrl.includes(PROD_SUPABASE)) {
    console.warn(
      '[SECURITY WARNING] NODE_ENV=development but SUPABASE_URL points to PRODUCTION. ' +
      'Use a separate Supabase project for development to avoid data corruption.'
    );
    warned = true;
  }
}
