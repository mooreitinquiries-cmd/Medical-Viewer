import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Calculator, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  addRevenueAdjustment,
  deleteRevenueAdjustment,
  fetchStudies,
  listRevenueAdjustments,
  type RevenueAdjustment,
  type Study,
} from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { showErrorToast } from '@/lib/errorToast';
import { toast } from 'sonner';

type RevenueLine = {
  id: string;
  source: 'study' | 'manual';
  date: string;
  label: string;
  amount: number;
  clientName: string;
  subclient: string;
  detail?: string;
};

type RevenueSubclientGroup = {
  name: string;
  variants: Set<string>;
  amount: number;
  count: number;
};

type RevenueClientGroup = {
  name: string;
  variants: Set<string>;
  amount: number;
  count: number;
  subclients: RevenueSubclientGroup[];
};

function toLocalDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseRevenueAmount(value: unknown) {
  const text = String(value ?? '').replace(/[$,\s]/g, '').trim();
  if (!text) return 0;
  const amount = Number(text);
  return Number.isFinite(amount) ? amount : 0;
}

function getStudyRevenueDate(study: Study) {
  const studyDate = String(study.study_date || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(studyDate)) return studyDate.slice(0, 10);
  const createdAt = String(study.created_at || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(createdAt)) return createdAt.slice(0, 10);
  return '';
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(value || 0);
}

function sumLines(lines: RevenueLine[], predicate: (line: RevenueLine) => boolean) {
  return lines.filter(predicate).reduce((total, line) => total + line.amount, 0);
}

function normalizeMatchName(value: string) {
  return value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function levenshteinDistance(left: string, right: string) {
  if (left === right) return 0;
  if (!left) return right.length;
  if (!right) return left.length;

  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = Array.from({ length: right.length + 1 }, () => 0);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + substitutionCost
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length];
}

function nameSimilarity(left: string, right: string) {
  const normalizedLeft = normalizeMatchName(left);
  const normalizedRight = normalizeMatchName(right);
  if (!normalizedLeft && !normalizedRight) return 1;
  if (!normalizedLeft || !normalizedRight) return 0;
  const maxLength = Math.max(normalizedLeft.length, normalizedRight.length);
  return maxLength === 0 ? 1 : 1 - levenshteinDistance(normalizedLeft, normalizedRight) / maxLength;
}

function addVariant(variants: Set<string>, value: string) {
  const cleaned = value.trim();
  if (cleaned) variants.add(cleaned);
}

function findFuzzyGroup<T extends { name: string }>(groups: T[], name: string) {
  const exact = groups.find((group) => normalizeMatchName(group.name) === normalizeMatchName(name));
  if (exact) return exact;

  let bestGroup: T | null = null;
  let bestScore = 0;
  groups.forEach((group) => {
    const score = nameSimilarity(group.name, name);
    if (score >= 0.85 && score > bestScore) {
      bestScore = score;
      bestGroup = group;
    }
  });
  return bestGroup;
}

function formatVariants(variants: Set<string>, primaryName: string) {
  return Array.from(variants)
    .filter((variant) => normalizeMatchName(variant) !== normalizeMatchName(primaryName))
    .sort((left, right) => left.localeCompare(right));
}

export default function RevenueCalculator() {
  const { user } = useAuth();
  const studyApiAuth = useMemo(
    () => (user ? { email: user.email, role: user.role, name: user.name } : undefined),
    [user]
  );
  const [studies, setStudies] = useState<Study[]>([]);
  const [adjustments, setAdjustments] = useState<RevenueAdjustment[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [entryDate, setEntryDate] = useState(toLocalDateKey());
  const [entryAmount, setEntryAmount] = useState('');
  const [entryLabel, setEntryLabel] = useState('Pre-software revenue');
  const [entryClientName, setEntryClientName] = useState('');
  const [entrySubclient, setEntrySubclient] = useState('');
  const [entryNotes, setEntryNotes] = useState('');
  const todayKey = toLocalDateKey();
  const currentMonth = todayKey.slice(0, 7);
  const currentYear = todayKey.slice(0, 4);

  const load = useCallback(async () => {
    if (!studyApiAuth) return;
    setLoading(true);
    try {
      const [studyItems, adjustmentItems] = await Promise.all([
        fetchStudies({ auth: studyApiAuth }),
        listRevenueAdjustments({ auth: studyApiAuth }),
      ]);
      setStudies(studyItems);
      setAdjustments(adjustmentItems);
    } catch (err) {
      showErrorToast(err, 'Failed to load revenue data');
    } finally {
      setLoading(false);
    }
  }, [studyApiAuth]);

  useEffect(() => {
    void load();
  }, [load]);

  const lines = useMemo<RevenueLine[]>(() => {
    const studyLines = studies
      .map((study) => {
        const amount = parseRevenueAmount(study.revenue);
        const date = getStudyRevenueDate(study);
        if (!date || amount === 0) return null;
        return {
          id: `study-${study.id}`,
          source: 'study' as const,
          date,
          label: study.patient_name || `Study #${study.id}`,
          amount,
          clientName: study.client_name || '',
          subclient: study.subclient || '',
          detail: [study.modality, study.client_name, study.subclient, study.md_name].filter(Boolean).join(' / '),
        };
      })
      .filter(Boolean) as RevenueLine[];

    const manualLines = adjustments.map((entry) => ({
      id: entry.id,
      source: 'manual' as const,
      date: entry.date,
      label: entry.label,
      amount: Number(entry.amount) || 0,
      clientName: entry.client_name || '',
      subclient: entry.subclient || '',
      detail: entry.notes || '',
    }));

    return [...studyLines, ...manualLines].sort((left, right) => {
      const dateCompare = right.date.localeCompare(left.date);
      if (dateCompare !== 0) return dateCompare;
      return right.label.localeCompare(left.label);
    });
  }, [adjustments, studies]);

  const revenueByClient = useMemo<RevenueClientGroup[]>(() => {
    const groups: RevenueClientGroup[] = [];

    lines.forEach((line) => {
      const clientName = line.clientName.trim() || 'Unassigned Client';
      const subclientName = line.subclient.trim() || 'No Subclient';
      let clientGroup = findFuzzyGroup(groups, clientName);

      if (!clientGroup) {
        clientGroup = {
          name: clientName,
          variants: new Set([clientName]),
          amount: 0,
          count: 0,
          subclients: [],
        };
        groups.push(clientGroup);
      }

      clientGroup.amount += line.amount;
      clientGroup.count += 1;
      addVariant(clientGroup.variants, clientName);

      let subclientGroup = findFuzzyGroup(clientGroup.subclients, subclientName);
      if (!subclientGroup) {
        subclientGroup = {
          name: subclientName,
          variants: new Set([subclientName]),
          amount: 0,
          count: 0,
        };
        clientGroup.subclients.push(subclientGroup);
      }

      subclientGroup.amount += line.amount;
      subclientGroup.count += 1;
      addVariant(subclientGroup.variants, subclientName);
    });

    return groups
      .map((group) => ({
        ...group,
        subclients: group.subclients.sort((left, right) => right.amount - left.amount),
      }))
      .sort((left, right) => right.amount - left.amount);
  }, [lines]);

  const totals = useMemo(() => {
    const today = sumLines(lines, (line) => line.date === todayKey);
    const month = sumLines(lines, (line) => line.date.startsWith(currentMonth));
    const ytd = sumLines(lines, (line) => line.date.startsWith(currentYear) && line.date <= todayKey);
    const all = lines.reduce((total, line) => total + line.amount, 0);
    return { today, month, ytd, all };
  }, [currentMonth, currentYear, lines, todayKey]);

  const submitManualEntry = async () => {
    if (!studyApiAuth) return;
    const amount = parseRevenueAmount(entryAmount);
    if (!entryDate) {
      toast.error('Enter a revenue date');
      return;
    }
    if (!amount) {
      toast.error('Enter a non-zero revenue amount');
      return;
    }
    try {
      setSaving(true);
      const saved = await addRevenueAdjustment(
        {
          date: entryDate,
          amount,
          label: entryLabel.trim() || 'Manual revenue',
          client_name: entryClientName.trim(),
          subclient: entrySubclient.trim(),
          notes: entryNotes.trim(),
        },
        { auth: studyApiAuth }
      );
      setAdjustments((prev) => [saved, ...prev]);
      setEntryAmount('');
      setEntryClientName('');
      setEntrySubclient('');
      setEntryNotes('');
      toast.success('Revenue entry added');
    } catch (err) {
      showErrorToast(err, 'Failed to add revenue entry');
    } finally {
      setSaving(false);
    }
  };

  const removeManualEntry = async (entryId: string) => {
    if (!studyApiAuth) return;
    try {
      await deleteRevenueAdjustment(entryId, { auth: studyApiAuth });
      setAdjustments((prev) => prev.filter((entry) => entry.id !== entryId));
      toast.success('Revenue entry removed');
    } catch (err) {
      showErrorToast(err, 'Failed to remove revenue entry');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Revenue Calculator</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Study revenue plus manual entries for off-system or pre-launch revenue.
          </p>
        </div>
        <Button type="button" variant="outline" onClick={() => void load()} disabled={loading}>
          Refresh
        </Button>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        {[
          ['Today', totals.today],
          ['Month to date', totals.month],
          ['Year to date', totals.ytd],
          ['All tracked', totals.all],
        ].map(([label, value]) => (
          <div key={label as string} className="rounded-lg border bg-card p-4">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
            <div className="mt-2 text-2xl font-semibold tabular-nums">{formatCurrency(value as number)}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
        <div className="rounded-lg border bg-card p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <Plus className="h-4 w-4" />
            Add Manual Revenue
          </div>
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Date</label>
              <Input type="date" value={entryDate} onChange={(event) => setEntryDate(event.target.value)} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Amount</label>
              <Input value={entryAmount} onChange={(event) => setEntryAmount(event.target.value)} placeholder="1250.00" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Label</label>
              <Input value={entryLabel} onChange={(event) => setEntryLabel(event.target.value)} maxLength={120} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Client</label>
              <Input
                value={entryClientName}
                onChange={(event) => setEntryClientName(event.target.value)}
                placeholder="Client name"
                maxLength={120}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Subclient</label>
              <Input
                value={entrySubclient}
                onChange={(event) => setEntrySubclient(event.target.value)}
                placeholder="Subclient name"
                maxLength={120}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Notes</label>
              <Textarea value={entryNotes} onChange={(event) => setEntryNotes(event.target.value)} rows={3} />
            </div>
            <Button type="button" className="w-full" onClick={() => void submitManualEntry()} disabled={saving}>
              {saving ? 'Adding...' : 'Add Revenue'}
            </Button>
          </div>
        </div>

        <Tabs defaultValue="lines" className="rounded-lg border bg-card">
          <div className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Calculator className="h-4 w-4" />
              Revenue
            </div>
            <TabsList>
              <TabsTrigger value="lines">Lines</TabsTrigger>
              <TabsTrigger value="clients">Clients</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="lines" className="m-0">
            <div className="flex items-center justify-end border-b px-4 py-2">
              <Badge variant="secondary">{lines.length} entries</Badge>
            </div>
            {loading ? (
              <div className="p-4 text-sm text-muted-foreground">Loading revenue...</div>
            ) : lines.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">No revenue has been logged yet.</div>
            ) : (
              <div className="max-h-[36rem] overflow-auto">
                <table className="w-full min-w-[900px] text-sm">
                  <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                    <tr className="border-b">
                      <th className="px-3 py-2 text-left font-medium">Date</th>
                      <th className="px-3 py-2 text-left font-medium">Source</th>
                      <th className="px-3 py-2 text-left font-medium">Description</th>
                      <th className="px-3 py-2 text-left font-medium">Client</th>
                      <th className="px-3 py-2 text-left font-medium">Subclient</th>
                      <th className="px-3 py-2 text-right font-medium">Amount</th>
                      <th className="px-3 py-2 text-right font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line) => (
                      <tr key={`${line.source}-${line.id}`} className="border-b last:border-0">
                        <td className="px-3 py-2 tabular-nums">{line.date}</td>
                        <td className="px-3 py-2">
                          <Badge variant={line.source === 'manual' ? 'outline' : 'secondary'}>
                            {line.source === 'manual' ? 'Manual' : 'Study'}
                          </Badge>
                        </td>
                        <td className="px-3 py-2 preserve-case">
                          <div className="font-medium">{line.label}</div>
                          {line.detail && <div className="text-xs text-muted-foreground">{line.detail}</div>}
                        </td>
                        <td className="px-3 py-2 preserve-case">{line.clientName || '-'}</td>
                        <td className="px-3 py-2 preserve-case">{line.subclient || '-'}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(line.amount)}</td>
                        <td className="px-3 py-2 text-right">
                          {line.source === 'manual' ? (
                            <Button type="button" size="sm" variant="ghost" onClick={() => void removeManualEntry(line.id)}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          ) : (
                            <span className="text-xs text-muted-foreground">Locked</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </TabsContent>

          <TabsContent value="clients" className="m-0">
            {loading ? (
              <div className="p-4 text-sm text-muted-foreground">Loading revenue...</div>
            ) : revenueByClient.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">No client revenue has been logged yet.</div>
            ) : (
              <div className="max-h-[36rem] overflow-auto">
                <table className="w-full min-w-[860px] text-sm">
                  <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                    <tr className="border-b">
                      <th className="px-3 py-2 text-left font-medium">Client</th>
                      <th className="px-3 py-2 text-left font-medium">Subclient</th>
                      <th className="px-3 py-2 text-right font-medium">Entries</th>
                      <th className="px-3 py-2 text-right font-medium">Revenue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {revenueByClient.map((client) => {
                      const clientVariants = formatVariants(client.variants, client.name);
                      return (
                        <Fragment key={`client-group-${client.name}`}>
                          <tr key={`client-${client.name}`} className="border-b bg-muted/30">
                            <td className="px-3 py-2 preserve-case">
                              <div className="font-semibold">{client.name}</div>
                              {clientVariants.length > 0 ? (
                                <div className="text-xs text-muted-foreground">Matched: {clientVariants.join(', ')}</div>
                              ) : null}
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">All subclients</td>
                            <td className="px-3 py-2 text-right tabular-nums">{client.count}</td>
                            <td className="px-3 py-2 text-right font-semibold tabular-nums">{formatCurrency(client.amount)}</td>
                          </tr>
                          {client.subclients.map((subclient) => {
                            const subclientVariants = formatVariants(subclient.variants, subclient.name);
                            return (
                              <tr key={`subclient-${client.name}-${subclient.name}`} className="border-b last:border-0">
                                <td className="px-3 py-2" />
                                <td className="px-3 py-2 preserve-case">
                                  <div>{subclient.name}</div>
                                  {subclientVariants.length > 0 ? (
                                    <div className="text-xs text-muted-foreground">
                                      Matched: {subclientVariants.join(', ')}
                                    </div>
                                  ) : null}
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums">{subclient.count}</td>
                                <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(subclient.amount)}</td>
                              </tr>
                            );
                          })}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
                <div className="border-t px-4 py-2 text-xs text-muted-foreground">
                  Names with at least an 85% match are grouped to catch misspellings.
                </div>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
