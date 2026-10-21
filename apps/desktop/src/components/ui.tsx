import { createPortal } from "react-dom";
import { Ellipsis } from "lucide-react";
import {
  createContext,
  useContext,
  useOptimistic,
  useTransition,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  Button,
  Spinner,
  buttonVariants,
  Card,
  Checkbox,
  Dropdown,
  Chip,
  Description,
  EmptyState,
  FieldError,
  Input,
  Label,
  ListBox,
  Modal as HeroModal,
  NumberField,
  ProgressBar,
  Select,
  Switch,
  Table,
  TextArea,
  TextField,
} from "@heroui/react";

/** True while an action runs; blocks the controls of an open dialog, which is what started it. */
export const BusyContext = createContext(false);
/** The actions under way, by the key `perform` got. */
export const PendingContext = createContext<ReadonlySet<string>>(new Set());
export const usePending = () => useContext(PendingContext);
/** A button for an action that can take a while: a spinner while `perform` runs it under `pendingKey`. */
export function ActionButton({ pendingKey, children, ...props }: ComponentProps<typeof Button> & { pendingKey: string; children: ReactNode }) {
  const pending = usePending().has(pendingKey);
  return (
    <Button {...props} isPending={pending}>
      {pending && <Spinner size="sm" color="current" />}
      {children}
    </Button>
  );
}

/** Where a view's page actions go: the card header, beside the title. */
export const HeaderSlot = createContext<HTMLElement | null>(null);
export function HeaderActions({ children }: { children: ReactNode }) {
  const slot = useContext(HeaderSlot);
  return slot && createPortal(children, slot);
}

/** A group of rows, in the manner of System Settings. Untitled when it is the whole page. */
export function Panel({
  title,
  detail,
  action,
  foot,
  children,
}: {
  title?: string;
  detail?: string;
  action?: ReactNode;
  foot?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="section">
      {title && (
        <div className="section-head">
          <div>
            <h2>{title}</h2>
            {detail && <p>{detail}</p>}
          </div>
          {action}
        </div>
      )}
      <Card className="rows">{children}</Card>
      {foot && <p className="group-foot">{foot}</p>}
    </section>
  );
}
export function Empty({ children }: { children: ReactNode }) {
  return <EmptyState className="empty">{children}</EmptyState>;
}
export function Badge({
  children,
  good = false,
}: {
  children: ReactNode;
  good?: boolean;
}) {
  return (
    <Chip size="sm" variant="soft" color={good ? "success" : "default"}>
      {children}
    </Chip>
  );
}
/** A row's action that is under way, e.g. "Syncing". */
export function Working({ children }: { children: ReactNode }) {
  return (
    <Badge>
      <Spinner size="sm" color="current" />
      {children}
    </Badge>
  );
}
export function Quota({ value }: { value: number }) {
  return (
    <ProgressBar aria-label="Quota used" size="sm" value={value}>
      <ProgressBar.Track>
        <ProgressBar.Fill />
      </ProgressBar.Track>
    </ProgressBar>
  );
}
export function Modal({
  title,
  children,
  close,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
}) {
  const busy = useContext(BusyContext);
  return (
    <HeroModal.Backdrop isOpen onOpenChange={(open) => !open && close()}>
      <HeroModal.Container>
        <HeroModal.Dialog className="dialog">
          <HeroModal.CloseTrigger aria-label="Close dialog" />
          <HeroModal.Header>
            <HeroModal.Heading>{title}</HeroModal.Heading>
          </HeroModal.Header>
          <HeroModal.Body>
            <fieldset className="workspace" disabled={busy} inert={busy}>
              {children}
            </fieldset>
          </HeroModal.Body>
        </HeroModal.Dialog>
      </HeroModal.Container>
    </HeroModal.Backdrop>
  );
}
const Labelled = ({
  label,
  description,
}: {
  label: ReactNode;
  description?: ReactNode;
}) => (
  <span className="labelled">
    <Label>{label}</Label>
    {description && <Description>{description}</Description>}
  </span>
);
/** A labelled text input; it submits under `name`, like the native input it replaces. */
export function Field({
  label,
  description,
  placeholder,
  multiline = false,
  className = "field",
  ...props
}: ComponentProps<typeof TextField> & {
  label: ReactNode;
  description?: ReactNode;
  placeholder?: string;
  multiline?: boolean;
}) {
  return (
    <TextField className={className} {...props}>
      <Labelled label={label} description={description} />
      {multiline ? (
        <TextArea placeholder={placeholder} />
      ) : (
        <Input placeholder={placeholder} />
      )}
      <FieldError />
    </TextField>
  );
}
/** A labelled number input; the raw number submits under `name`. */
export function NumberInput({
  label,
  description,
  className = "field",
  ...props
}: ComponentProps<typeof NumberField> & {
  label: ReactNode;
  description?: ReactNode;
}) {
  return (
    <NumberField className={className} {...props}>
      <Labelled label={label} description={description} />
      <NumberField.Group>
        <NumberField.DecrementButton />
        <NumberField.Input />
        <NumberField.IncrementButton />
      </NumberField.Group>
      <FieldError />
    </NumberField>
  );
}
/** A labelled select over fixed options; it submits the chosen id under `name`. */
export function Choice({
  label,
  description,
  options,
  className = "field",
  ...props
}: ComponentProps<typeof Select> & {
  label: ReactNode;
  description?: ReactNode;
  options: { id: string; label: string }[];
}) {
  return (
    <Select className={className} {...props}>
      <Labelled label={label} description={description} />
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {options.map((o) => (
            <ListBox.Item key={o.id} id={o.id} textValue={o.label}>
              {o.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}
/** A labelled switch, label first as in System Settings. */
/** A switch that moves when clicked. When `onChange` returns a promise (a `perform`), it shows the new value while the
 * change is saved, and whatever the daemon reports afterwards. */
export function LiveSwitch({ isSelected, onChange, ...props }: Omit<ComponentProps<typeof Switch>, "onChange"> & {
  onChange?: (on: boolean) => unknown;
}) {
  const [shown, show] = useOptimistic(!!isSelected);
  const [, start] = useTransition();
  return (
    <Switch
      {...props}
      isSelected={shown}
      onChange={(on) => start(async () => { show(on); await onChange?.(on); })}
    />
  );
}
export function Toggle({
  label,
  description,
  className = "item",
  ...props
}: ComponentProps<typeof LiveSwitch> & {
  label: ReactNode;
  description?: ReactNode;
}) {
  return (
    <LiveSwitch className={className} {...props}>
      <Switch.Content className="toggle">
        <Labelled label={label} description={description} />
        <Switch.Control>
          <Switch.Thumb />
        </Switch.Control>
      </Switch.Content>
    </LiveSwitch>
  );
}
/** A checkbox that submits `name=value` (default `on`), like the native one it replaces. Without children, give it an aria-label. */
export function Check({
  children,
  value = "on",
  ...props
}: ComponentProps<typeof Checkbox> & { children?: ReactNode }) {
  return (
    <Checkbox value={value} {...props}>
      <Checkbox.Content className="check">
        <Checkbox.Control>
          <Checkbox.Indicator />
        </Checkbox.Control>
        {children}
      </Checkbox.Content>
    </Checkbox>
  );
}

type MenuAction = { label: string; onAction: () => void; danger?: boolean };
/** A row's secondary actions behind "⋯"; falsy entries are skipped. */
export function RowMenu({ label, items }: { label: string; items: (MenuAction | false | undefined)[] }) {
  const list = items.filter((i): i is MenuAction => !!i);
  if (!list.length) return null;
  return (
    <Dropdown>
      {/* The trigger's own display: inline-block would undo the button's centering. */}
      <Dropdown.Trigger aria-label={label} className={`${buttonVariants({ variant: "ghost", size: "sm", isIconOnly: true })} inline-flex!`}>
        <Ellipsis size={16} />
      </Dropdown.Trigger>
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu onAction={(key) => list[Number(key)]?.onAction()}>
          {list.map((i, n) => (
            <Dropdown.Item key={n} id={String(n)} textValue={i.label} variant={i.danger ? "danger" : "default"}>
              {i.label}
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

/** A before-and-after table for reviewing changes before they are saved. */
export function Changes({ rows }: { rows: [label: string, before: ReactNode, after: ReactNode][] }) {
  return (
    <Table className="changes">
      <Table.ScrollContainer>
        <Table.Content aria-label="Changes">
          <Table.Header>
            <Table.Column isRowHeader>Setting</Table.Column>
            <Table.Column>Before</Table.Column>
            <Table.Column>After</Table.Column>
          </Table.Header>
          <Table.Body>
            {rows.map(([label, before, after]) => (
              <Table.Row key={label} id={label}>
                <Table.Cell>{label}</Table.Cell>
                <Table.Cell>{before}</Table.Cell>
                <Table.Cell>{after}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
    </Table>
  );
}
