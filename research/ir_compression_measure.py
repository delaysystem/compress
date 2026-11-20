"""Measure IR compression ratios on author-constructed support samples.
Full text vs hand-authored IR sketch, counted with tiktoken (cl100k_base + o200k_base).
Labels: CONSTRUCTED samples, not model-emitted IR; measures format potential, not conformance."""
import tiktoken

SAMPLES = [
    {
        "name": "short-refund-status",
        "full": ("Hi Maria, thanks for reaching out! I've checked on your refund for order #48291 "
                 "and it's been processed. You should see the $42.50 back on your Visa ending in 4417 "
                 "within 3-5 business days. Let me know if it hasn't arrived by Friday!"),
        "ir": ("@lang=en @tone=friendly\n"
               "#P1 intent=confirm-refund-processed order=>V1< amount=>V2< method=>V3< eta=>V4<\n"
               "#P2 intent=offer-followup deadline=>V5<\n"
               "@V V1=#48291 V2=$42.50 V3=\"Visa ending in 4417\" V4=\"3-5 business days\" V5=Friday"),
    },
    {
        "name": "medium-password-reset",
        "full": ("Hello! Sorry you're having trouble signing in. Here's how to reset your password:\n\n"
                 "1. Go to our login page at https://example.com/login and click \"Forgot password\".\n"
                 "2. Enter the email address tied to your account (the one this message was sent to).\n"
                 "3. Check your inbox for a reset link — it expires after 60 minutes.\n"
                 "4. Click the link and choose a new password with at least 12 characters.\n\n"
                 "If you don't see the email within 10 minutes, please check your spam folder, "
                 "or contact us at support@example.com and we'll help you out."),
        "ir": ("@lang=en @tone=helpful\n"
               "#P1 intent=empathize-login-trouble\n"
               "#P2 intent=list-reset-steps #FMT=numbered-list(4)\n"
               " step1=go=>V1<+click=>V2< step2=enter-account-email step3=open-reset-link expiry=>V3< "
               "step4=set-new-password minlen=>V4<\n"
               "#P3 intent=fallback-missing-email wait=>V5< check=spam contact=>V6<\n"
               "@V V1=https://example.com/login V2=\"Forgot password\" V3=\"60 minutes\" "
               "V4=\"12 characters\" V5=\"10 minutes\" V6=support@example.com"),
    },
    {
        "name": "long-billing-explainer",
        "full": ("Hi James, great question — I can explain the two charges on your March statement.\n\n"
                 "On March 3rd, you were billed $29.00 for your monthly Pro plan renewal. This is a "
                 "recurring charge that happens on the 3rd of each month. Then on March 17th, there was "
                 "a one-time charge of $12.50 for the extra storage add-on you enabled on March 15th "
                 "(50 GB at $0.25 per GB). That add-on will renew automatically each month unless you "
                 "turn it off under Settings > Billing > Add-ons.\n\n"
                 "So your total for March was $41.50. Your next bill on April 3rd will be $29.00 if you "
                 "keep the add-on, or $41.50 if you keep it — sorry, let me be precise: $29.00 for the "
                 "plan plus $12.50 for the add-on, so $41.50 total. You can view the full invoices at "
                 "https://example.com/account/invoices.\n\n"
                 "Would you like me to turn off auto-renew for the storage add-on?"),
        "ir": ("@lang=en @tone=clear\n"
               "#P1 intent=ack-billing-question month=>V1<\n"
               "#P2 intent=explain-charge date=>V2< amount=>V3< reason=\"Pro renewal\" recur=>V4< #FMT=pair\n"
               "#P3 intent=explain-charge date=>V5< amount=>V6< reason=>V7< enabled=>V8< rate=>V9< "
               "autorenew=on disable-path=>V10< #FMT=pair\n"
               "#P4 intent=state-total month=>V1< total=>V11< next-date=>V12< next-total=>V11< "
               "invoices=>V13<\n"
               "#P5 intent=offer-disable-autorenew target=>V7<\n"
               "@V V1=March V2=\"March 3rd\" V3=$29.00 V4=\"3rd monthly\" V5=\"March 17th\" V6=$12.50 "
               "V7=\"storage add-on\" V8=\"March 15th\" V9=\"$0.25/GB\" V10=\"Settings>Billing>Add-ons\" "
               "V11=$41.50 V12=\"April 3rd\" V13=https://example.com/account/invoices"),
    },
    {
        "name": "list-shipping-options",
        "full": ("Here are your shipping options for the order:\n\n"
                 "- Standard (5-7 business days): $4.99, free on orders over $50.\n"
                 "- Express (2-3 business days): $12.99.\n"
                 "- Overnight (next business day by noon): $24.99, order within 4 hours.\n\n"
                 "All options include tracking. Express and Overnight require a signature on delivery. "
                 "Shipping to PO boxes is only available with Standard."),
        "ir": ("@lang=en @tone=neutral\n"
               "#P1 intent=intro-shipping-options #FMT=bullet-list(3)\n"
               " opt1=name=Standard eta=>V1< price=>V2< freemin=>V3<\n"
               " opt2=name=Express eta=>V4< price=>V5<\n"
               " opt3=name=Overnight eta=>V6< price=>V7< cutoff=>V8<\n"
               "#P2 intent=state-conditions tracking=all signature=\"Express+Overnight\" pobox=Standard-only\n"
               "@V V1=\"5-7 business days\" V2=$4.99 V3=$50 V4=\"2-3 business days\" V5=$12.99 "
               "V6=\"next business day by noon\" V7=$24.99 V8=\"4 hours\""),
    },
    {
        "name": "link-date-heavy-outage",
        "full": ("Hi everyone, here's an update on the service disruption from Tuesday, November 4th.\n\n"
                 "What happened: between 14:02 and 15:47 UTC, our API returned 500 errors for about 35% "
                 "of requests. The cause was a bad configuration push (change #CHG-2211) that overloaded "
                 "our primary database. We rolled it back at 15:47 UTC and error rates returned to normal "
                 "by 16:05 UTC.\n\n"
                 "What we're doing: we've added a guardrail so config pushes above 1000 QPS require two "
                 "approvals, and the full postmortem will be published at https://example.com/status/chg-2211 "
                 "by Friday, November 14th. Affected customers will receive a 10% service credit automatically — "
                 "no action needed on your part.\n\n"
                 "I sincerely apologize for the disruption. If you saw errors outside the 14:02–15:47 UTC "
                 "window, please write to reliability@example.com with your request IDs."),
        "ir": ("@lang=en @tone=apologetic-formal\n"
               "#P1 intent=announce-outage-update date=>V1<\n"
               "#P2 intent=describe-incident window=>V2< symptom=\"API 500s\" impact=>V3< cause=>V4< "
               "rollback=>V5< recovered=>V6< #FMT=prose\n"
               "#P3 intent=state-remediation guardrail=>V7< postmortem=>V8< due=>V9< credit=>V10<\n"
               "#P4 intent=apologize+contact oos-window=>V2< contact=>V11<\n"
               "@V V1=\"Tuesday, November 4th\" V2=\"14:02-15:47 UTC\" V3=\"35% of requests\" "
               "V4=\"config push #CHG-2211\" V5=\"15:47 UTC\" V6=\"16:05 UTC\" V7=\"2 approvals >1000 QPS\" "
               "V8=https://example.com/status/chg-2211 V9=\"Friday, November 14th\" V10=\"10% auto credit\" "
               "V11=reliability@example.com"),
    },
]

for enc_name in ("cl100k_base", "o200k_base"):
    enc = tiktoken.get_encoding(enc_name)
    print(f"=== {enc_name} ===")
    tot_full = tot_ir = 0
    for s in SAMPLES:
        nf = len(enc.encode(s["full"]))
        ni = len(enc.encode(s["ir"]))
        tot_full += nf
        tot_ir += ni
        print(f"{s['name']}: full={nf} ir={ni} ratio={nf/ni:.2f}x saved={nf-ni}")
    print(f"TOTAL: full={tot_full} ir={tot_ir} ratio={tot_full/tot_ir:.2f}x")
    print()
