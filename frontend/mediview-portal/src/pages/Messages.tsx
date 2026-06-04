import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Search, Video } from 'lucide-react';
import { toast } from 'sonner';
import {
  listCareContacts,
  listCareMessages,
  sendCareMessage,
  type CareContact,
  type CareMessage,
} from '@/lib/careApi';

const OU_LABEL: Record<CareContact['role'], string> = {
  admin: 'Admins',
  doctor: 'Doctors',
  clinic: 'Clinics',
  patient: 'Patients',
};

export default function Messages() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [contacts, setContacts] = useState<CareContact[]>([]);
  const [selectedContactEmail, setSelectedContactEmail] = useState('');
  const [messagesByContact, setMessagesByContact] = useState<Record<string, CareMessage[]>>({});
  const [loadingContacts, setLoadingContacts] = useState(true);
  const [loadingThread, setLoadingThread] = useState(false);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState('');

  useEffect(() => {
    const loadContacts = async () => {
      try {
        setLoadingContacts(true);
        const data = await listCareContacts();
        const nextContacts = data.contacts || [];
        setContacts(nextContacts);

        const queryContact = searchParams.get('contact')?.toLowerCase() || '';
        const preferred =
          nextContacts.find((contact) => contact.email.toLowerCase() === queryContact)?.email ||
          nextContacts[0]?.email ||
          '';
        setSelectedContactEmail((prev) => prev || preferred);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Failed to load contacts');
      } finally {
        setLoadingContacts(false);
      }
    };

    loadContacts();
  }, []);

  useEffect(() => {
    const queryContact = searchParams.get('contact')?.toLowerCase() || '';
    if (!queryContact || contacts.length === 0) return;

    const exists = contacts.some((contact) => contact.email.toLowerCase() === queryContact);
    if (exists) {
      setSelectedContactEmail(queryContact);
    }
  }, [searchParams, contacts]);

  useEffect(() => {
    const selected = contacts.find((entry) => entry.email.toLowerCase() === selectedContactEmail.toLowerCase());
    if (!selected) return;

    const loadThread = async () => {
      try {
        setLoadingThread(true);
        const data = await listCareMessages(selected.email);
        setMessagesByContact((prev) => ({
          ...prev,
          [selected.email]: data.messages || [],
        }));
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Failed to load messages');
      } finally {
        setLoadingThread(false);
      }
    };

    loadThread();
  }, [contacts, selectedContactEmail]);

  const filteredContacts = useMemo(() => {
    return contacts.filter((contact) => {
      if (!search.trim()) return true;
      const value = `${contact.name} ${contact.title} ${contact.role}`.toLowerCase();
      return value.includes(search.toLowerCase());
    });
  }, [contacts, search]);

  const selectedContact =
    filteredContacts.find((contact) => contact.email.toLowerCase() === selectedContactEmail.toLowerCase()) ??
    filteredContacts[0];

  const thread = selectedContact ? messagesByContact[selectedContact.email] || [] : [];

  const groupedContacts = useMemo(() => {
    return filteredContacts.reduce<Record<CareContact['role'], CareContact[]>>(
      (acc, contact) => {
        acc[contact.role].push(contact);
        return acc;
      },
      { admin: [], doctor: [], clinic: [], patient: [] }
    );
  }, [filteredContacts]);

  const handleSendMessage = async () => {
    if (!selectedContact || !draft.trim()) return;

    try {
      const response = await sendCareMessage(selectedContact.email, draft.trim());
      setMessagesByContact((prev) => ({
        ...prev,
        [selectedContact.email]: [...(prev[selectedContact.email] || []), response.message],
      }));
      setDraft('');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to send message');
    }
  };

  if (loadingContacts) {
    return <div className="p-6 text-sm text-muted-foreground">Loading contacts...</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Messaging</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Secure messaging between patients, doctors, clinics, and admin.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <div className="rounded-xl border bg-card p-4 shadow-sm">
          <div className="relative mb-4">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-9"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search contacts"
            />
          </div>

          <div className="space-y-4">
            {(['admin', 'doctor', 'clinic', 'patient'] as const).map((ou) => {
              if (groupedContacts[ou].length === 0) return null;

              return (
                <div key={ou}>
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {OU_LABEL[ou]}
                  </div>
                  <div className="space-y-2">
                    {groupedContacts[ou].map((contact) => {
                      const selected = selectedContact?.email === contact.email;
                      return (
                        <button
                          key={contact.email}
                          type="button"
                          onClick={() => setSelectedContactEmail(contact.email)}
                          className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                            selected ? 'border-primary bg-primary/5' : 'hover:bg-muted'
                          }`}
                        >
                          <div className="font-medium">{contact.name}</div>
                          <div className="text-xs text-muted-foreground">{contact.title}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded-xl border bg-card p-4 shadow-sm">
          {!selectedContact ? (
            <div className="p-6 text-sm text-muted-foreground">No contacts found.</div>
          ) : (
            <>
              <div className="mb-4 flex items-center justify-between border-b pb-4">
                <div className="flex items-center gap-3">
                  <Avatar>
                    <AvatarFallback>{selectedContact.name.slice(0, 2).toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <div>
                    <div className="font-semibold">{selectedContact.name}</div>
                    <div className="text-xs text-muted-foreground">{selectedContact.title}</div>
                  </div>
                  <Badge variant="secondary" className="ml-2 uppercase">
                    {selectedContact.role}
                  </Badge>
                </div>

                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigate(`/video?target=${encodeURIComponent(selectedContact.name)}`)}
                >
                  <Video className="mr-2 h-4 w-4" />
                  Start Video Call
                </Button>
              </div>

              <div className="mb-4 h-[360px] space-y-3 overflow-y-auto rounded-md border bg-muted/30 p-4">
                {loadingThread ? (
                  <div className="text-sm text-muted-foreground">Loading thread...</div>
                ) : thread.length === 0 ? (
                  <div className="text-sm text-muted-foreground">No messages yet. Send the first message.</div>
                ) : (
                  thread.map((message) => {
                    const mine = message.senderEmail !== selectedContact.email;
                    return (
                      <div
                        key={message.id}
                        className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                          mine ? 'ml-auto bg-primary text-primary-foreground' : 'bg-background'
                        }`}
                      >
                        <div>{message.body}</div>
                        <div
                          className={`mt-1 text-[11px] ${
                            mine ? 'text-primary-foreground/70' : 'text-muted-foreground'
                          }`}
                        >
                          {new Date(message.createdAt).toLocaleString()}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              <div className="space-y-3">
                <Textarea
                  rows={3}
                  placeholder={`Message ${selectedContact.name}...`}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <div className="flex justify-end">
                  <Button disabled={!draft.trim()} onClick={handleSendMessage}>
                    Send Message
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
