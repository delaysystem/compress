"""v2: test whether a MINIMAL telegraphic sketch can compress at all.
Same full texts, terser IR (no intent vocab, no #FMT, values inline bare)."""
import tiktoken

SAMPLES = [
    {
        "name": "short-refund-status",
        "full": ("Hi Maria, thanks for reaching out! I've checked on your refund for order #48291 "
                 "and it's been processed. You should see the $42.50 back on your Visa ending in 4417 "
                 "within 3-5 business days. Let me know if it hasn't arrived by Friday!"),
        "ir_min": "Maria: refund #48291 done, $42.50 -> Visa ..4417, 3-5 biz days; ping if missing by Fri",
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
        "ir_min": ("pw reset: 1 login https://example.com/login >Forgot password 2 enter acct email "
                   "3 inbox link, 60min expiry 4 new pw 12+ chars // no mail in 10min: spam or support@example.com"),
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
        "ir_min": ("Mar stmt, James: 3/3 $29 Pro renewal (monthly 3rd); 3/17 $12.50 storage add-on "
                   "(on 3/15, 50GB@$0.25/GB, autorenew; off: Settings>Billing>Add-ons). Total $41.50; "
                   "next 4/3 $41.50. invoices: https://example.com/account/invoices. Offer: disable autorenew?"),
    },
]

for enc_name in ("cl100k_base", "o200k_base"):
    enc = tiktoken.get_encoding(enc_name)
    print(f"=== {enc_name} (minimal telegraphic IR) ===")
    for s in SAMPLES:
        nf = len(enc.encode(s["full"]))
        ni = len(enc.encode(s["ir_min"]))
        print(f"{s['name']}: full={nf} ir={ni} ratio={nf/ni:.2f}x saved={nf-ni}")
    print()
