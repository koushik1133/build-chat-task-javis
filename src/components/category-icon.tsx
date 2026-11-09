import { Bell, Bot, CalendarDays, CheckSquare, LifeBuoy, PieChart, Receipt, Settings, Users, type LucideIcon } from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  approvals: CheckSquare,
  helpdesk: LifeBuoy,
  billing: Receipt,
  bookings: CalendarDays,
  agents: Bot,
  team: Users,
  reports: PieChart,
  system: Settings,
};

/** Icon for a notification category (falls back to a bell). */
export function CategoryIcon({ category, className }: { category: string | null | undefined; className?: string }) {
  const Icon = (category && ICONS[category]) || Bell;
  return <Icon className={className} aria-hidden />;
}
