/* From Supabase -> Settings -> API Keys.
   The publishable key is designed to ship in the browser: it is powerless
   without a signed-in session, and row-level security decides what a session
   can see. The secret key never appears here — it lives in an environment
   variable on a machine you control. */
window.RS_CONFIG = {
  SUPABASE_URL: "https://eaplfufdhmkrsdiuopsx.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_nEJRXPqK8pgtWopQ_zLg8A_uCyS4_4w",

  /* Shown on the paused screen so a suspended customer can pay you without
     phoning anyone. A client row can override it with its own pay_url.
     Put your Stripe payment link or billing-portal URL here. */
  PAY_URL: "https://buy.stripe.com/fZu3cw1bg38ydpv95k0Ba03"
};
