import { redirect } from "next/navigation";

export default function Home() {
  // The call is the product. The board at /loads is the reference behind it.
  redirect("/call");
}
