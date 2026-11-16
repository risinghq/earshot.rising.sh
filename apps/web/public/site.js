// Progressive enhancement only: the <details> account menu already opens and
// closes with keyboard and pointer. This closes it on outside click, Escape,
// or after picking an item, which <details> does not do on its own.
const account = document.querySelector("details.account");
if (account) {
  document.addEventListener("click", (event) => {
    if (account.open && !account.contains(event.target)) account.open = false;
  });
  account.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      account.open = false;
      account.querySelector("summary").focus();
    }
  });
  account.addEventListener("toggle", () => {
    if (account.open) account.querySelector(".account-menu a")?.focus();
  });
  account
    .querySelectorAll(".account-menu a, .account-menu button")
    .forEach((item) =>
      item.addEventListener("click", () => (account.open = false)),
    );
}
