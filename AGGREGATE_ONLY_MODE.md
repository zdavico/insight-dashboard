# Aggregate Only Mode

How to hide the "By Cohort / Aggregate" toggle and lock the dashboard to aggregate view.

Useful when presenting to leadership or sharing with stakeholders who only need the big-picture Kickoff vs Exit comparison.

---

## To enable aggregate-only mode

Two changes in `src/App.js`:

### 1. Set the default state to aggregate

Find this line (near the top of the `App` function, around line 860):

```jsx
const [aggregate, setAggregate] = useState(false);
```

Change `false` to `true`:

```jsx
const [aggregate, setAggregate] = useState(true);
```

### 2. Hide the toggle buttons

Find this block (around line 970):

```jsx
<div style={{ display: "flex", marginBottom: 6 }}>
  <Btn active={!aggregate} onClick={() => handleAggToggle(false)} pos="left">
    By Cohort
  </Btn>
  <Btn active={aggregate} onClick={() => handleAggToggle(true)} pos="right">
    Aggregate
  </Btn>
</div>
```

Wrap it with `{false && ... }`:

```jsx
{false && (
  <div style={{ display: "flex", marginBottom: 6 }}>
    <Btn active={!aggregate} onClick={() => handleAggToggle(false)} pos="left">
      By Cohort
    </Btn>
    <Btn active={aggregate} onClick={() => handleAggToggle(true)} pos="right">
      Aggregate
    </Btn>
  </div>
)}
```

Save the file. The dashboard hot-reloads with only aggregate data visible and no toggle.

---

## To revert back to normal

1. Change `useState(true)` back to `useState(false)`
2. Remove the `{false && (` and matching `)}` wrapper

Save. The toggle reappears.
