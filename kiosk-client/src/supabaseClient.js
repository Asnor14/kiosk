import { createClient } from '@supabase/supabase-js';

// REPLACE THESE WITH YOUR REAL SUPABASE CREDENTIALS
const supabaseUrl = 'https://wwkouiuiivmudnafiynn.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind3a291aXVpaXZtdWRuYWZpeW5uIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ1MDMyNjUsImV4cCI6MjA4MDA3OTI2NX0.s_MTCkRBloWqLfuOBHA2SAZ-A8-qhhWiMkTYYoDNRR0';

export const supabase = createClient(supabaseUrl, supabaseKey);