import { EditorTabs } from "@/components/editor-tabs";
import { Features } from "@/components/features";
import { Hero } from "@/components/hero";
import { Receipts } from "@/components/receipts";
import { SiteHeader } from "@/components/site-header";

export default function Page() {
  return (
    <>
      <SiteHeader />
      <main>
        <Hero />
        <Features />
        <EditorTabs />
        <Receipts />
      </main>
    </>
  );
}
