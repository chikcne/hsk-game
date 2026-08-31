(() => {
  const menu = document.querySelector(".scroll-menu");
  const currentChoice = document.querySelector(".current-choice");
  if (menu && currentChoice) {
    menu.addEventListener("click", (event) => {
      const column = event.target.closest(".scroll-column");
      if (!column) return;
      menu.querySelectorAll(".scroll-column").forEach((item) => item.classList.remove("selected", "active"));
      column.classList.add("selected");
      currentChoice.textContent = column.dataset.label || column.textContent.trim();
    });
  }

  const answer = document.querySelector(".typed-answer");
  const keyboard = document.querySelector(".touch-keyboard");
  if (answer && keyboard) {
    let value = "niha";
    const render = () => { answer.innerHTML = `${value}<span class="caret"></span>`; };
    keyboard.addEventListener("pointerdown", (event) => {
      const key = event.target.closest("button");
      if (!key) return;
      key.classList.add("down");
    });
    keyboard.addEventListener("pointerup", (event) => {
      const key = event.target.closest("button");
      if (!key) return;
      key.classList.remove("down");
      const label = key.querySelector("span")?.textContent?.trim() || "";
      if (key.classList.contains("backspace")) value = value.slice(0, -1);
      else if (key.classList.contains("enter")) {
        const active = document.querySelector(".active-lane .phrase");
        active?.classList.remove("writing");
        active?.classList.add("solved");
      } else if (label.length === 1 && /^[A-Z]$/.test(label)) value += label.toLowerCase();
      render();
    });
    keyboard.addEventListener("pointercancel", () => keyboard.querySelectorAll(".down").forEach((key) => key.classList.remove("down")));
  }
})();
