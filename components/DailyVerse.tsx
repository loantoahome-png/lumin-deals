'use client'

import { useEffect, useState } from 'react'
import { BookOpen } from 'lucide-react'

// Verse of the Day — a curated, offline rotation (no external API). Indexed by
// day-of-year so every team member sees the same verse on a given day, and it
// advances to a different one each morning. ~60 verses → cycles ~6×/year.
type Verse = { text: string; ref: string }

const VERSES: Verse[] = [
  { text: 'For I know the plans I have for you, declares the Lord, plans to prosper you and not to harm you, plans to give you hope and a future.', ref: 'Jeremiah 29:11' },
  { text: 'I can do all things through Christ who strengthens me.', ref: 'Philippians 4:13' },
  { text: 'Trust in the Lord with all your heart and lean not on your own understanding; in all your ways submit to him, and he will make your paths straight.', ref: 'Proverbs 3:5-6' },
  { text: 'Be strong and courageous. Do not be afraid; do not be discouraged, for the Lord your God will be with you wherever you go.', ref: 'Joshua 1:9' },
  { text: 'But those who hope in the Lord will renew their strength. They will soar on wings like eagles; they will run and not grow weary, they will walk and not be faint.', ref: 'Isaiah 40:31' },
  { text: 'The Lord is my shepherd; I shall not want.', ref: 'Psalm 23:1' },
  { text: 'And we know that in all things God works for the good of those who love him, who have been called according to his purpose.', ref: 'Romans 8:28' },
  { text: 'But seek first the kingdom of God and his righteousness, and all these things will be added to you.', ref: 'Matthew 6:33' },
  { text: 'Do not be anxious about anything, but in every situation, by prayer and petition, with thanksgiving, present your requests to God.', ref: 'Philippians 4:6' },
  { text: 'Commit to the Lord whatever you do, and he will establish your plans.', ref: 'Proverbs 16:3' },
  { text: 'This is the day the Lord has made; let us rejoice and be glad in it.', ref: 'Psalm 118:24' },
  { text: 'For we walk by faith, not by sight.', ref: '2 Corinthians 5:7' },
  { text: 'Whatever you do, work at it with all your heart, as working for the Lord, not for human masters.', ref: 'Colossians 3:23' },
  { text: 'God is our refuge and strength, an ever-present help in trouble.', ref: 'Psalm 46:1' },
  { text: 'So do not fear, for I am with you; do not be dismayed, for I am your God. I will strengthen you and help you.', ref: 'Isaiah 41:10' },
  { text: 'Come to me, all you who are weary and burdened, and I will give you rest.', ref: 'Matthew 11:28' },
  { text: 'Take delight in the Lord, and he will give you the desires of your heart.', ref: 'Psalm 37:4' },
  { text: 'Let us not become weary in doing good, for at the proper time we will reap a harvest if we do not give up.', ref: 'Galatians 6:9' },
  { text: 'Being confident of this, that he who began a good work in you will carry it on to completion until the day of Christ Jesus.', ref: 'Philippians 1:6' },
  { text: 'May the favor of the Lord our God rest on us; establish the work of our hands for us—yes, establish the work of our hands.', ref: 'Psalm 90:17' },
  { text: 'The plans of the diligent lead to profit as surely as haste leads to poverty.', ref: 'Proverbs 21:5' },
  { text: 'If any of you lacks wisdom, you should ask God, who gives generously to all without finding fault, and it will be given to you.', ref: 'James 1:5' },
  { text: 'I lift up my eyes to the mountains—where does my help come from? My help comes from the Lord, the Maker of heaven and earth.', ref: 'Psalm 121:1-2' },
  { text: 'Be joyful in hope, patient in affliction, faithful in prayer.', ref: 'Romans 12:12' },
  { text: 'For God has not given us a spirit of fear, but of power and of love and of a sound mind.', ref: '2 Timothy 1:7' },
  { text: 'A generous person will prosper; whoever refreshes others will be refreshed.', ref: 'Proverbs 11:25' },
  { text: 'The Lord is my strength and my shield; my heart trusts in him, and he helps me.', ref: 'Psalm 28:7' },
  { text: 'Let your light shine before others, that they may see your good deeds and glorify your Father in heaven.', ref: 'Matthew 5:16' },
  { text: 'Now faith is confidence in what we hope for and assurance about what we do not see.', ref: 'Hebrews 11:1' },
  { text: 'I praise you because I am fearfully and wonderfully made; your works are wonderful, I know that full well.', ref: 'Psalm 139:14' },
  { text: 'As iron sharpens iron, so one person sharpens another.', ref: 'Proverbs 27:17' },
  { text: 'For we are God’s handiwork, created in Christ Jesus to do good works, which God prepared in advance for us to do.', ref: 'Ephesians 2:10' },
  { text: 'I keep my eyes always on the Lord. With him at my right hand, I will not be shaken.', ref: 'Psalm 16:8' },
  { text: 'Because of the Lord’s great love we are not consumed, for his compassions never fail. They are new every morning; great is your faithfulness.', ref: 'Lamentations 3:22-23' },
  { text: 'In this world you will have trouble. But take heart! I have overcome the world.', ref: 'John 16:33' },
  { text: 'Cast your cares on the Lord and he will sustain you; he will never let the righteous be shaken.', ref: 'Psalm 55:22' },
  { text: 'Above all else, guard your heart, for everything you do flows from it.', ref: 'Proverbs 4:23' },
  { text: 'You will keep in perfect peace those whose minds are steadfast, because they trust in you.', ref: 'Isaiah 26:3' },
  { text: 'Rejoice always, pray continually, give thanks in all circumstances; for this is God’s will for you in Christ Jesus.', ref: '1 Thessalonians 5:16-18' },
  { text: 'A gentle answer turns away wrath, but a harsh word stirs up anger.', ref: 'Proverbs 15:1' },
  { text: 'My flesh and my heart may fail, but God is the strength of my heart and my portion forever.', ref: 'Psalm 73:26' },
  { text: 'Do not grieve, for the joy of the Lord is your strength.', ref: 'Nehemiah 8:10' },
  { text: 'He has shown you, O mortal, what is good: to act justly and to love mercy and to walk humbly with your God.', ref: 'Micah 6:8' },
  { text: 'May the God of hope fill you with all joy and peace as you trust in him, so that you may overflow with hope.', ref: 'Romans 15:13' },
  { text: 'Taste and see that the Lord is good; blessed is the one who takes refuge in him.', ref: 'Psalm 34:8' },
  { text: 'In their hearts humans plan their course, but the Lord establishes their steps.', ref: 'Proverbs 16:9' },
  { text: 'Cast all your anxiety on him because he cares for you.', ref: '1 Peter 5:7' },
  { text: 'The Lord is my light and my salvation—whom shall I fear? The Lord is the stronghold of my life—of whom shall I be afraid?', ref: 'Psalm 27:1' },
  { text: 'Be strong and courageous. Do not be afraid... for the Lord your God goes with you; he will never leave you nor forsake you.', ref: 'Deuteronomy 31:6' },
  { text: 'Blessed is the one who perseveres under trial because, having stood the test, that person will receive the crown of life.', ref: 'James 1:12' },
  { text: 'Enter his gates with thanksgiving and his courts with praise; give thanks to him and praise his name.', ref: 'Psalm 100:4' },
  { text: 'Do you see someone skilled in their work? They will serve before kings; they will not serve before officials of low rank.', ref: 'Proverbs 22:29' },
  { text: 'Jesus looked at them and said, “With man this is impossible, but with God all things are possible.”', ref: 'Matthew 19:26' },
  { text: 'Be strong and take heart, all you who hope in the Lord.', ref: 'Psalm 31:24' },
  { text: 'But the fruit of the Spirit is love, joy, peace, forbearance, kindness, goodness, faithfulness, gentleness and self-control.', ref: 'Galatians 5:22-23' },
  { text: 'See, I am doing a new thing! Now it springs up; do you not perceive it?', ref: 'Isaiah 43:19' },
  { text: 'Therefore encourage one another and build each other up, just as in fact you are doing.', ref: '1 Thessalonians 5:11' },
  { text: 'The Lord will fight for you; you need only to be still.', ref: 'Exodus 14:14' },
  { text: 'And my God will meet all your needs according to the riches of his glory in Christ Jesus.', ref: 'Philippians 4:19' },
  { text: 'Whatever you do, do it all for the glory of God.', ref: '1 Corinthians 10:31' },
]

function dayOfYear(d: Date): number {
  const start = new Date(d.getFullYear(), 0, 0)
  return Math.floor((d.getTime() - start.getTime()) / 86_400_000)
}

export default function DailyVerse() {
  // Compute on the client after mount so the day is the user's local day and
  // there is never a server/client hydration mismatch. Until then, show the
  // first verse (a stable placeholder that swaps in-tick to today's).
  const [idx, setIdx] = useState(0)
  useEffect(() => { setIdx(dayOfYear(new Date()) % VERSES.length) }, [])
  const verse = VERSES[idx]

  return (
    <div className="flex items-start gap-3 rounded-xl border border-orange-200 bg-gradient-to-r from-orange-50 to-white px-4 py-3">
      <div className="mt-0.5 shrink-0 rounded-lg bg-[#F37021]/10 p-1.5">
        <BookOpen className="h-4 w-4 text-[#F37021]" />
      </div>
      <div className="min-w-0">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-[#F37021]">Verse of the Day</p>
        <p className="mt-0.5 text-sm italic leading-snug text-slate-700">
          &ldquo;{verse.text}&rdquo;
          <span className="ml-1.5 whitespace-nowrap text-xs font-semibold not-italic text-slate-500">— {verse.ref}</span>
        </p>
      </div>
    </div>
  )
}
