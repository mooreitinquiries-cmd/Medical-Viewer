import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CheckCircle2, CreditCard, Mail, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { completeWhiteLabelSignup, getWhiteLabelSignupDetails, type WhiteLabelSignupDetails } from '@/lib/sessionApi';
import { validatePassword, validateUsername } from '@/lib/auth';
import { showErrorToast } from '@/lib/errorToast';

function formatCurrency(value: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);
}

export default function WhiteLabelSignup() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const [details, setDetails] = useState<WhiteLabelSignupDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [organizationName, setOrganizationName] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [billingEmail, setBillingEmail] = useState('');
  const [serviceAddress, setServiceAddress] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [plan, setPlan] = useState('self_download_7_day');
  const [doctorSeats, setDoctorSeats] = useState(1);
  const [complianceAcknowledged, setComplianceAcknowledged] = useState(false);

  useEffect(() => {
    if (!token) return;
    let robotsMeta = document.querySelector('meta[name="robots"]') as HTMLMetaElement | null;
    if (!robotsMeta) {
      robotsMeta = document.createElement('meta');
      robotsMeta.name = 'robots';
      document.head.appendChild(robotsMeta);
    }
    robotsMeta.content = 'noindex,nofollow';
    setLoading(true);
    getWhiteLabelSignupDetails(token)
      .then((result) => {
        setDetails(result);
        setOrganizationName(result.invite.organizationName || '');
        setContactName(result.invite.recipientName || '');
        setContactEmail(result.invite.recipientEmail || '');
        setBillingEmail(result.invite.recipientEmail || '');
        setUsername((result.invite.recipientEmail || '').split('@')[0] || '');
        setPlan(result.plans[0]?.id || 'self_download_7_day');
      })
      .catch((error) => showErrorToast(error, 'Signup link unavailable'))
      .finally(() => setLoading(false));
  }, [token]);

  const selectedPlan = useMemo(
    () => details?.plans.find((item) => item.id === plan) || details?.plans[0] || null,
    [details?.plans, plan]
  );
  const monthlyTotal = (selectedPlan?.pricePerDoctorMonthly || 0) * doctorSeats;

  const submit = async () => {
    if (!token || !selectedPlan) return;
    const usernameError = validateUsername(username);
    const passwordError = validatePassword(password);
    if (!organizationName.trim() || !contactName.trim() || !contactEmail.trim() || !billingEmail.trim()) {
      toast.error('Organization, contact, and billing email are required.');
      return;
    }
    if (usernameError || passwordError) {
      toast.error(usernameError || passwordError);
      return;
    }
    if (!complianceAcknowledged) {
      toast.error('Confirm the retention and billing terms before subscribing.');
      return;
    }

    setSubmitting(true);
    try {
      const result = await completeWhiteLabelSignup(token, {
        organizationName: organizationName.trim(),
        contactName: contactName.trim(),
        contactEmail: contactEmail.trim().toLowerCase(),
        contactPhone: contactPhone.trim(),
        billingEmail: billingEmail.trim().toLowerCase(),
        serviceAddress: serviceAddress.trim(),
        username: username.trim().toLowerCase(),
        password,
        plan: selectedPlan.id,
        doctorSeats,
        complianceAcknowledged,
      });
      toast.success('Subscription profile created');
      if (result.paymentSetupUrl) {
        window.location.assign(result.paymentSetupUrl);
        return;
      }
      navigate('/white-label', { replace: true });
    } catch (error) {
      showErrorToast(error, 'Could not complete signup');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">Checking signup link...</div>;
  }

  if (!details) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <Alert className="max-w-lg">
          <ShieldCheck className="h-4 w-4" />
          <AlertTitle>Private signup link unavailable</AlertTitle>
          <AlertDescription>
            This link may be expired or already used. Contact OCTELERAD at{' '}
            <a className="font-medium underline" href="mailto:operations@octelerad.com">operations@octelerad.com</a>.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
          <div>
            <h1 className="text-xl font-semibold">OCTELERAD PACS Subscription</h1>
            <p className="text-sm text-muted-foreground">Private enrollment for invited hospital and radiology partners.</p>
          </div>
          <Badge variant="secondary">Invite only</Badge>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-4 px-4 py-6 lg:grid-cols-[1fr_360px]">
        <section className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Organization</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="org-name">Hospital or group name</Label>
                <Input id="org-name" value={organizationName} onChange={(event) => setOrganizationName(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="service-address">Service address</Label>
                <Input id="service-address" value={serviceAddress} onChange={(event) => setServiceAddress(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="contact-name">Primary contact</Label>
                <Input id="contact-name" value={contactName} onChange={(event) => setContactName(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="contact-email">Contact email</Label>
                <Input id="contact-email" type="email" value={contactEmail} onChange={(event) => setContactEmail(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="contact-phone">Contact phone</Label>
                <Input id="contact-phone" value={contactPhone} onChange={(event) => setContactPhone(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="billing-email">Billing email</Label>
                <Input id="billing-email" type="email" value={billingEmail} onChange={(event) => setBillingEmail(event.target.value)} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Owner Login</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="owner-username">Username</Label>
                <Input id="owner-username" value={username} onChange={(event) => setUsername(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="owner-password">Password</Label>
                <Input id="owner-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Plan</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 md:grid-cols-2">
                {details.plans.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setPlan(option.id)}
                    className={`rounded-lg border p-4 text-left ${plan === option.id ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-semibold">{option.label}</div>
                      {plan === option.id && <CheckCircle2 className="h-4 w-4 text-primary" />}
                    </div>
                    <div className="mt-2 text-2xl font-semibold">{formatCurrency(option.pricePerDoctorMonthly)}</div>
                    <div className="text-sm text-muted-foreground">per doctor / month</div>
                    <p className="mt-3 text-sm text-muted-foreground">{option.description}</p>
                  </button>
                ))}
              </div>
              <div className="grid gap-4 md:grid-cols-[220px_1fr]">
                <div className="space-y-2">
                  <Label htmlFor="doctor-seats">Doctors / radiologists</Label>
                  <Input
                    id="doctor-seats"
                    type="number"
                    min={1}
                    max={500}
                    value={doctorSeats}
                    onChange={(event) => setDoctorSeats(Math.max(1, Number(event.target.value) || 1))}
                  />
                </div>
                <div className="rounded-md border bg-muted/20 p-3 text-sm">
                  <div className="font-medium">Estimated monthly subscription</div>
                  <div className="mt-1 text-2xl font-semibold">{formatCurrency(monthlyTotal)}</div>
                  <div className="text-muted-foreground">
                    {doctorSeats} doctor{doctorSeats === 1 ? '' : 's'} at {formatCurrency(selectedPlan?.pricePerDoctorMonthly || 0)} each
                  </div>
                </div>
              </div>
              <label className="flex items-start gap-3 rounded-md border p-3 text-sm">
                <input
                  type="checkbox"
                  checked={complianceAcknowledged}
                  onChange={(event) => setComplianceAcknowledged(event.target.checked)}
                  className="mt-1"
                />
                <span>
                  I understand this subscription is priced per doctor/radiologist and that data retention follows the selected plan.
                </span>
              </label>
            </CardContent>
          </Card>
        </section>

        <aside className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <CreditCard className="h-4 w-4" />
                Subscription Summary
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Plan</span>
                <span className="text-right font-medium">{selectedPlan?.label}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Retention</span>
                <span>{selectedPlan?.retentionDays} days</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Doctor seats</span>
                <span>{doctorSeats}</span>
              </div>
              <div className="border-t pt-3">
                <div className="flex justify-between gap-3 text-base font-semibold">
                  <span>Monthly total</span>
                  <span>{formatCurrency(monthlyTotal)}</span>
                </div>
              </div>
              <Button type="button" className="w-full" onClick={() => void submit()} disabled={submitting}>
                {submitting ? 'Creating subscription...' : 'Subscribe'}
              </Button>
            </CardContent>
          </Card>

          <Alert>
            <Mail className="h-4 w-4" />
            <AlertTitle>Custom quote</AlertTitle>
            <AlertDescription>
              For enterprise volume, integrations, or custom retention, email{' '}
              <a className="font-medium underline" href={`mailto:${details.customQuoteEmail}`}>
                {details.customQuoteEmail}
              </a>.
            </AlertDescription>
          </Alert>

          <div className="text-xs text-muted-foreground">
            Already enrolled? <Link to="/login" className="font-medium underline">Sign in</Link>
          </div>
        </aside>
      </main>
    </div>
  );
}
