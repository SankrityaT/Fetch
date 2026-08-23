import { EditorTabs } from "@/components/editor-tabs";
import { Hero } from "@/components/hero";
import { Receipts } from "@/components/receipts";
import { Story } from "@/components/story";
import { SiteHeader } from "@/components/site-header";

export default function Page() {
  return (
    <>
      <SiteHeader />
      <main>
        <Hero />
        <Story />
        <EditorTabs />
        <Receipts />
      </main>
    </>
  );
}
