import { EditorTabs } from "@/components/editor-tabs";
import { Hero } from "@/components/hero";
import { SiteHeader } from "@/components/site-header";

export default function Page() {
  return (
    <>
      <SiteHeader />
      <main>
        <Hero />
        <EditorTabs />
      </main>
    </>
  );
}
