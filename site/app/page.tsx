import { Accountable } from "@/components/accountable";
import { Agents } from "@/components/agents";
import { ByHand } from "@/components/by-hand";
import { Closing } from "@/components/closing";
import { Hero } from "@/components/hero";
import { MeetBiscuit } from "@/components/meet-biscuit";
import { Prompts } from "@/components/prompts";
import { RealMachine } from "@/components/real-machine";
import { Receipts } from "@/components/receipts";
import { SiteHeader } from "@/components/site-header";

/* Hook, then the proof, then trust, then the ask. The order a sceptical
 * developer asks the questions in: what is it, does it work with my setup, why
 * not the other one, what can it do, can I trust it with my screen. */
export default function Page() {
  return (
    <>
      <SiteHeader />
      <main>
        <Hero />
        <Agents />
        <RealMachine />
        <Prompts />
        <Accountable />
        <MeetBiscuit />
        <ByHand />
        <Receipts />
      </main>
      <Closing />
    </>
  );
}
